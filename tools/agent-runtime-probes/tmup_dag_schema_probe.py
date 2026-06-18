#!/usr/bin/env python3
"""Metadata-only tmup SQLite DAG/schema probe.

This inspects tmup source/schema files and local SQLite state without dumping task
subjects, task descriptions, message payloads, event payloads, prompt files, or project
paths. It is a proof probe for the tmup task-DAG layer, not a worker launcher.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path
from typing import Any

from probelib import load_json, sha256_16 as sha16_text


SCHEMA = "agent-runtime-tmup-dag-schema"
SCHEMA_VERSION = "0.1"
HOME = Path.home()
PLUGIN_ROOT = HOME / ".claude/plugins/tmup"
STATE_ROOT = HOME / ".local/state/tmup"

KNOWN_TABLES = [
    "tasks",
    "task_deps",
    "task_artifacts",
    "artifacts",
    "messages",
    "agents",
    "events",
    "schema_version",
    "plans",
    "plan_reviews",
    "research_packets",
    "plan_tasks",
    "task_attempts",
    "evidence_packets",
    "execution_targets",
    "lifecycle_events",
    "task_corrections",
]

GROUPED_COUNTS = {
    "tasks": ["status", "failure_reason", "worker_type", "sdlc_loop_level"],
    "agents": ["status"],
    "messages": ["type"],
    "events": ["event_type"],
    "plans": ["status"],
    "task_attempts": ["status", "failure_reason", "model_family"],
    "evidence_packets": ["type", "reviewer_disposition"],
    "execution_targets": ["type"],
    "lifecycle_events": ["event_type"],
}


def text_file(path: Path) -> dict[str, Any]:
    try:
        text = path.read_text(errors="replace")
        return {"text": text, "status": "ok", "error_type": None}
    except OSError as exc:
        return {"text": "", "status": "error", "error_type": type(exc).__name__}


def mode_octal(path: Path) -> dict[str, Any]:
    try:
        return {"mode": oct(path.stat().st_mode & 0o777), "status": "ok", "error_type": None}
    except OSError as exc:
        return {"mode": None, "status": "error", "error_type": type(exc).__name__}


def source_schema_summary(plugin_root: Path) -> dict[str, Any]:
    schema_path = plugin_root / "config/schema.sql"
    migrations_path = plugin_root / "shared/src/migrations.ts"
    db_path = plugin_root / "shared/src/db.ts"
    schema_sql_info = text_file(schema_path)
    migrations_ts_info = text_file(migrations_path)
    db_ts_info = text_file(db_path)
    schema_sql = str(schema_sql_info["text"])
    migrations_ts = str(migrations_ts_info["text"])
    db_ts = str(db_ts_info["text"])
    migration_versions = [int(v) for v in re.findall(r"\bversion:\s*(\d+)", migrations_ts)]
    pragma_keys = re.findall(r"^\s+([a-z_]+):\s+'(?:integer|string)'", db_ts, re.M)
    return {
        "schema_sql_path": str(schema_path),
        "schema_sql_read_status": schema_sql_info["status"],
        "schema_sql_read_error_type": schema_sql_info["error_type"],
        "schema_sql_sha256_16": sha16_text(schema_sql) if schema_sql else None,
        "schema_sql_tables": re.findall(r"CREATE TABLE IF NOT EXISTS\s+([a-zA-Z_][a-zA-Z0-9_]*)", schema_sql, re.I),
        "schema_sql_indexes": re.findall(r"CREATE INDEX IF NOT EXISTS\s+([a-zA-Z_][a-zA-Z0-9_]*)", schema_sql, re.I),
        "schema_sql_triggers": re.findall(r"CREATE TRIGGER IF NOT EXISTS\s+([a-zA-Z_][a-zA-Z0-9_]*)", schema_sql, re.I),
        "migrations_path": str(migrations_path),
        "migrations_read_status": migrations_ts_info["status"],
        "migrations_read_error_type": migrations_ts_info["error_type"],
        "migration_versions_declared": migration_versions,
        "migration_latest_declared": max(migration_versions) if migration_versions else None,
        "db_init_path": str(db_path),
        "db_init_read_status": db_ts_info["status"],
        "db_init_read_error_type": db_ts_info["error_type"],
        "runtime_pragma_allowlist": pragma_keys,
    }


def state_inventory(state_root: Path) -> dict[str, Any]:
    files = [p for p in state_root.glob("**/*") if p.is_file()] if state_root.exists() else []
    by_suffix = {
        "db": len([p for p in files if p.name == "tmup.db"]),
        "wal": len([p for p in files if p.name.endswith(".db-wal")]),
        "shm": len([p for p in files if p.name.endswith(".db-shm")]),
        "grid_state": len([p for p in files if p.name == "grid-state.json"]),
        "prompt_files": len([p for p in files if p.name.startswith("prompt-") and p.suffix == ".txt"]),
        "launcher_files": len([p for p in files if p.name.startswith("launcher-") and p.suffix == ".sh"]),
    }
    return {
        "state_root": str(state_root),
        "exists": state_root.exists(),
        "file_count": len(files),
        "file_kind_counts": by_suffix,
        "redaction_note": "prompt and launcher file names/content are not emitted",
    }


def read_current_session(state_root: Path) -> dict[str, Any]:
    path = state_root / "current-session"
    if not path.exists():
        return {"path": str(path), "exists": False}
    try:
        session_id = path.read_text(errors="replace").strip()
    except OSError as exc:
        return {"path": str(path), "exists": True, "error": f"{type(exc).__name__}: {exc}"}
    mode_info = mode_octal(path)
    return {
        "path": str(path),
        "exists": True,
        "mode": mode_info["mode"],
        "mode_status": mode_info["status"],
        "mode_error_type": mode_info["error_type"],
        "session_id": session_id,
        "session_id_sha256_16": sha16_text(session_id),
    }


def registry_summary(state_root: Path, current_session_id: str | None) -> dict[str, Any]:
    path = state_root / "registry.json"
    if not path.exists():
        return {"path": str(path), "exists": False, "parse_status": "missing", "error_type": None}
    try:
        data = json.loads(path.read_text(errors="replace"))
    except Exception as exc:  # noqa: BLE001 - diagnostic script
        return {
            "path": str(path),
            "exists": True,
            "parse_status": "invalid_json",
            "error_type": type(exc).__name__,
            "error": f"{type(exc).__name__}: {exc}",
        }
    if not isinstance(data, dict):
        return {
            "path": str(path),
            "exists": True,
            "parse_status": "invalid_shape",
            "error_type": type(data).__name__,
            "session_count": 0,
            "current_session_in_registry": False,
            "unique_project_dir_hash_count": 0,
            "redaction_note": "project_dir values are hashed, not emitted",
        }
    sessions = data.get("sessions") if isinstance(data, dict) else {}
    if not isinstance(sessions, dict):
        sessions = {}
    current_entry = sessions.get(current_session_id or "") if current_session_id else None
    project_hashes = []
    for item in sessions.values():
        if isinstance(item, dict) and isinstance(item.get("project_dir"), str):
            project_hashes.append(sha16_text(item["project_dir"]))
    mode_info = mode_octal(path)
    return {
        "path": str(path),
        "exists": True,
        "parse_status": "ok",
        "error_type": None,
        "mode": mode_info["mode"],
        "mode_status": mode_info["status"],
        "mode_error_type": mode_info["error_type"],
        "session_count": len(sessions),
        "current_session_in_registry": bool(current_entry),
        "current_session_db_path": current_entry.get("db_path") if isinstance(current_entry, dict) else None,
        "current_session_project_dir_sha256_16": sha16_text(current_entry["project_dir"])
        if isinstance(current_entry, dict) and isinstance(current_entry.get("project_dir"), str) else None,
        "unique_project_dir_hash_count": len(set(project_hashes)),
        "redaction_note": "project_dir values are hashed, not emitted",
    }


def table_exists(cur: sqlite3.Cursor, table: str) -> bool:
    row = cur.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table,),
    ).fetchone()
    return row is not None


def column_exists(cur: sqlite3.Cursor, table: str, column: str) -> bool:
    try:
        return any(row[1] == column for row in cur.execute(f'PRAGMA table_info("{table}")').fetchall())
    except sqlite3.Error:
        return False


def count_rows(cur: sqlite3.Cursor, table: str) -> dict[str, Any]:
    if not table_exists(cur, table):
        return {"status": "missing_table", "count": None, "error_type": None}
    try:
        return {"status": "ok", "count": int(cur.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]), "error_type": None}
    except sqlite3.Error as exc:
        return {"status": "error", "count": None, "error_type": type(exc).__name__}


def grouped_counts(cur: sqlite3.Cursor, table: str, column: str) -> dict[str, int]:
    if not table_exists(cur, table) or not column_exists(cur, table, column):
        return {}
    rows = cur.execute(
        f'SELECT COALESCE(CAST("{column}" AS TEXT), "<null>") AS value, COUNT(*) FROM "{table}" GROUP BY "{column}" ORDER BY value'
    ).fetchall()
    return {str(value): int(count) for value, count in rows}


def inspect_db(path: Path, current_session_id: str | None) -> dict[str, Any]:
    mode_info = mode_octal(path) if path.exists() else {"mode": None, "status": "missing", "error_type": None}
    summary: dict[str, Any] = {
        "session_id": path.parent.name,
        "is_current": path.parent.name == current_session_id,
        "path": str(path),
        "exists": path.exists(),
        "bytes": path.stat().st_size if path.exists() else None,
        "mode": mode_info["mode"],
        "mode_status": mode_info["status"],
        "mode_error_type": mode_info["error_type"],
    }
    if not path.exists():
        return summary
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2)
        cur = con.cursor()
        objects = cur.execute(
            "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
        ).fetchall()
        table_names = [name for kind, name in objects if kind == "table"]
        index_names = [name for kind, name in objects if kind == "index"]
        trigger_names = [name for kind, name in objects if kind == "trigger"]
        row_count_infos = {table: count_rows(cur, table) for table in KNOWN_TABLES if table_exists(cur, table)}
        row_counts = {table: info["count"] for table, info in row_count_infos.items()}
        row_count_statuses = {table: info["status"] for table, info in row_count_infos.items()}
        row_count_error_types = {table: info["error_type"] for table, info in row_count_infos.items() if info.get("error_type")}
        grouped: dict[str, Any] = {}
        for table, columns in GROUPED_COUNTS.items():
            if table_exists(cur, table):
                grouped[table] = {
                    column: grouped_counts(cur, table, column)
                    for column in columns
                    if column_exists(cur, table, column)
                }
        schema_version = None
        if table_exists(cur, "schema_version"):
            row = cur.execute("SELECT MAX(version) FROM schema_version").fetchone()
            schema_version = row[0] if row else None
        journal_mode = cur.execute("PRAGMA journal_mode").fetchone()[0]
        quick_check = cur.execute("PRAGMA quick_check").fetchone()[0]
        con.close()
        summary.update({
            "open_status": "ok",
            "schema_version": schema_version,
            "journal_mode": journal_mode,
            "quick_check": quick_check,
            "table_count": len(table_names),
            "index_count": len(index_names),
            "trigger_count": len(trigger_names),
            "tables": table_names,
            "indexes": index_names,
            "triggers": trigger_names,
            "row_counts": row_counts,
            "row_count_statuses": row_count_statuses,
            "row_count_error_types": row_count_error_types,
            "grouped_counts": grouped,
        })
    except Exception as exc:  # noqa: BLE001 - diagnostic script
        summary.update({"open_status": "error", "error": f"{type(exc).__name__}: {exc}"})
    return summary


def db_summaries(state_root: Path, current_session_id: str | None, max_dbs: int | None) -> dict[str, Any]:
    paths = sorted(state_root.glob("*/tmup.db")) if state_root.exists() else []
    current_path = state_root / current_session_id / "tmup.db" if current_session_id else None
    selected = paths if max_dbs is None else paths[:max_dbs]
    if current_path and current_path.exists() and current_path not in selected:
        selected.append(current_path)
    inspected = [inspect_db(path, current_session_id) for path in selected]
    aggregate_status: dict[str, int] = {}
    for item in inspected:
        for status, count in item.get("grouped_counts", {}).get("tasks", {}).get("status", {}).items():
            aggregate_status[status] = aggregate_status.get(status, 0) + int(count)
    return {
        "db_count_total": len(paths),
        "db_count_inspected": len(inspected),
        "inspection_limit": max_dbs,
        "aggregate_task_status_counts_inspected": aggregate_status,
        "databases": inspected,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Emit metadata-only tmup DAG/schema report.")
    parser.add_argument("--plugin-root", type=Path, default=PLUGIN_ROOT)
    parser.add_argument("--state-root", type=Path, default=STATE_ROOT)
    parser.add_argument("--max-dbs", type=int, default=50, help="number of tmup.db files to inspect; current session is always included; use 0 for all")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()

    plugin_root = args.plugin_root.expanduser()
    state_root = args.state_root.expanduser()
    max_dbs = None if args.max_dbs == 0 else args.max_dbs

    current = read_current_session(state_root)
    current_session_id = current.get("session_id") if isinstance(current.get("session_id"), str) else None
    report = {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only; no task subjects/descriptions, message payloads, event payloads, prompt-file names/content, or raw project_dir values",
        "source": {
            "plugin_root": str(plugin_root),
            "source_schema": source_schema_summary(plugin_root),
            "runtime_contract": load_json(plugin_root / "config/runtime-contract.json"),
            "policy_path": str(plugin_root / "config/policy.yaml"),
            "system_inventory_path": str(plugin_root / "SYSTEM-INVENTORY.md"),
        },
        "state": state_inventory(state_root),
        "current_session": current,
        "registry": registry_summary(state_root, current_session_id),
        "sqlite": db_summaries(state_root, current_session_id, max_dbs),
        "verdict": {
            "proof_class": "local-static-plus-local-state",
            "r6_status": "schema-and-state-inventory-landed",
            "remaining_gap": "does not launch tmup workers, inspect tmux panes, emit payload text, or prove MCP tools are callable in the current model turn",
        },
    }
    try:
        json.dump(report, sys.stdout, indent=2 if args.pretty else None, sort_keys=True)
        sys.stdout.write("\n")
    except BrokenPipeError:
        try:
            sys.stdout.close()
        except OSError:
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
