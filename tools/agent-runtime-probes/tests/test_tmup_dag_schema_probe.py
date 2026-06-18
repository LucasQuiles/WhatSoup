#!/usr/bin/env python3
"""Safety tests for tmup_dag_schema_probe payload suppression."""
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from probelib import load_json  # noqa: E402
import tmup_dag_schema_probe as probe  # noqa: E402
from tmup_dag_schema_probe import (  # noqa: E402
    column_exists,
    count_rows,
    db_summaries,
    grouped_counts,
    inspect_db,
    main,
    mode_octal,
    read_current_session,
    registry_summary,
    source_schema_summary,
    state_inventory,
    table_exists,
    text_file,
)


def make_plugin_root(root: Path) -> Path:
    plugin = root / "plugin"
    (plugin / "config").mkdir(parents=True)
    (plugin / "shared/src").mkdir(parents=True)
    (plugin / "config/schema.sql").write_text(
        """
        CREATE TABLE IF NOT EXISTS tasks (id TEXT, subject TEXT, description TEXT, status TEXT);
        CREATE TABLE IF NOT EXISTS messages (id TEXT, type TEXT, payload TEXT);
        CREATE INDEX IF NOT EXISTS idx_tasks_claimable ON tasks(status);
        """,
        encoding="utf-8",
    )
    (plugin / "shared/src/migrations.ts").write_text(
        "export const migrations = [{ version: 1 }, { version: 4 }];",
        encoding="utf-8",
    )
    (plugin / "shared/src/db.ts").write_text(
        """
        const pragmaTypes = {
          journal_mode: 'string',
          busy_timeout: 'integer',
        };
        """,
        encoding="utf-8",
    )
    (plugin / "config/runtime-contract.json").write_text('{"journal_mode":"wal"}', encoding="utf-8")
    return plugin


def make_state_root(root: Path) -> Path:
    state = root / "state"
    session = state / "session-a"
    session.mkdir(parents=True)
    (state / "current-session").write_text("session-a\n", encoding="utf-8")
    (state / "registry.json").write_text(
        json.dumps(
            {
                "sessions": {
                    "session-a": {
                        "db_path": str(session / "tmup.db"),
                        "project_dir": "/Users/testuser/secret/project-alpha",
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    (session / "prompt-super-secret-task.txt").write_text("prompt body must not leak", encoding="utf-8")
    (session / "launcher-super-secret.sh").write_text("#!/bin/sh\n", encoding="utf-8")
    con = sqlite3.connect(session / "tmup.db")
    con.executescript(
        """
        CREATE TABLE schema_version (version INTEGER);
        INSERT INTO schema_version VALUES (4);
        CREATE TABLE tasks (
          id TEXT,
          subject TEXT,
          description TEXT,
          status TEXT,
          failure_reason TEXT,
          worker_type TEXT,
          sdlc_loop_level TEXT
        );
        INSERT INTO tasks VALUES (
          'task-1',
          'subject SECRET-TASK-SUBJECT',
          'description SECRET-TASK-DESCRIPTION',
          'pending',
          NULL,
          'codex',
          NULL
        );
        CREATE TABLE messages (id TEXT, type TEXT, payload TEXT);
        INSERT INTO messages VALUES ('msg-1', 'note', 'SECRET-MESSAGE-PAYLOAD');
        CREATE TABLE events (id TEXT, event_type TEXT, payload TEXT);
        INSERT INTO events VALUES ('evt-1', 'task_created', 'SECRET-EVENT-PAYLOAD');
        CREATE TABLE agents (id TEXT, status TEXT);
        INSERT INTO agents VALUES ('agent-1', 'shutdown');
        """
    )
    con.commit()
    con.close()
    return state


def build_synthetic_report(tmp: Path) -> dict:
    plugin = make_plugin_root(tmp)
    state = make_state_root(tmp)
    current = read_current_session(state)
    session_id = current["session_id"]
    return {
        "source": {
            "source_schema": source_schema_summary(plugin),
            "runtime_contract": load_json(plugin / "config/runtime-contract.json"),
        },
        "state": state_inventory(state),
        "current_session": current,
        "registry": registry_summary(state, session_id),
        "sqlite": db_summaries(state, session_id, None),
    }


def test_tmup_probe_counts_rows_without_payload_text():
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        report = build_synthetic_report(Path(tmp_dir))
        rendered = json.dumps(report, sort_keys=True)
        assert report["sqlite"]["db_count_total"] == 1, report
        db = report["sqlite"]["databases"][0]
        assert db["row_counts"]["tasks"] == 1, db
        assert db["row_counts"]["messages"] == 1, db
        assert db["row_counts"]["events"] == 1, db
        assert db["grouped_counts"]["tasks"]["status"] == {"pending": 1}, db
        assert "SECRET-TASK-SUBJECT" not in rendered, report
        assert "SECRET-TASK-DESCRIPTION" not in rendered, report
        assert "SECRET-MESSAGE-PAYLOAD" not in rendered, report
        assert "SECRET-EVENT-PAYLOAD" not in rendered, report


def test_tmup_probe_suppresses_prompt_filenames_and_project_dirs():
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        report = build_synthetic_report(Path(tmp_dir))
        rendered = json.dumps(report, sort_keys=True)
        assert report["state"]["file_kind_counts"]["prompt_files"] == 1, report
        assert report["state"]["file_kind_counts"]["launcher_files"] == 1, report
        assert report["registry"]["current_session_project_dir_sha256_16"], report
        assert "/Users/testuser/secret/project-alpha" not in rendered, report
        assert "prompt-super-secret-task.txt" not in rendered, report
        assert "launcher-super-secret.sh" not in rendered, report
        assert "prompt body must not leak" not in rendered, report


def test_tmup_probe_cli_report_suppresses_payload_text():
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        tmp = Path(tmp_dir)
        plugin = make_plugin_root(tmp)
        state = make_state_root(tmp)
        result = subprocess.run(
            [
                sys.executable,
                str(Path(__file__).resolve().parents[1] / "tmup_dag_schema_probe.py"),
                "--plugin-root",
                str(plugin),
                "--state-root",
                str(state),
                "--pretty",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        report = json.loads(result.stdout)
        assert result.stderr == "", result.stderr
        assert report["schema"] == "agent-runtime-tmup-dag-schema", report
        assert report["sqlite"]["databases"][0]["row_counts"]["tasks"] == 1, report
        assert report["sqlite"]["databases"][0]["row_counts"]["messages"] == 1, report
        assert report["registry"]["current_session_project_dir_sha256_16"], report
        for forbidden in [
            "SECRET-TASK-SUBJECT",
            "SECRET-TASK-DESCRIPTION",
            "SECRET-MESSAGE-PAYLOAD",
            "SECRET-EVENT-PAYLOAD",
            "/Users/testuser/secret/project-alpha",
            "prompt-super-secret-task.txt",
            "launcher-super-secret.sh",
            "prompt body must not leak",
        ]:
            assert forbidden not in result.stdout, forbidden


def test_tmup_registry_malformed_json_reports_error_not_empty_sessions():
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        tmp = Path(tmp_dir)
        state = tmp / "state"
        state.mkdir()
        (state / "current-session").write_text("session-a\n", encoding="utf-8")
        (state / "registry.json").write_text("{not valid json", encoding="utf-8")

        report = registry_summary(state, "session-a")

        assert report["exists"] is True, report
        assert report["parse_status"] == "invalid_json", report
        assert report["error_type"] == "JSONDecodeError", report
        assert "session_count" not in report, report


# ─── text_file() OSError path ────────────────────────────────────────────────

def test_text_file_missing_path_returns_error_status():
    result = text_file(Path("/nonexistent-xyz-path/schema.sql"))
    assert result["status"] == "error", result
    assert result["text"] == "", result
    assert result["error_type"] in {"FileNotFoundError", "OSError"}, result


def test_text_file_existing_path_returns_content():
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        p = Path(tmp_dir) / "test.sql"
        p.write_text("SELECT 1;", encoding="utf-8")
        result = text_file(p)
        assert result["status"] == "ok", result
        assert result["text"] == "SELECT 1;", result
        assert result["error_type"] is None, result


# ─── mode_octal() OSError path ───────────────────────────────────────────────

def test_mode_octal_missing_path_returns_error():
    result = mode_octal(Path("/nonexistent-xyz-path/file.txt"))
    assert result["status"] == "error", result
    assert result["mode"] is None, result
    assert result["error_type"] in {"FileNotFoundError", "OSError"}, result


def test_mode_octal_existing_path_returns_mode():
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        p = Path(tmp_dir) / "file.txt"
        p.write_text("x", encoding="utf-8")
        result = mode_octal(p)
        assert result["status"] == "ok", result
        assert result["mode"] is not None, result
        assert result["mode"].startswith("0o"), result


# ─── read_current_session() missing + OSError paths ──────────────────────────

def test_read_current_session_missing_state_root():
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        state = Path(tmp_dir) / "no-such-state"
        result = read_current_session(state)
        assert result["exists"] is False, result
        assert "session_id" not in result, result


def test_read_current_session_ioerror_reading_file():
    """Simulate OSError when reading the current-session file."""
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        state = Path(tmp_dir) / "state"
        state.mkdir()
        cs_path = state / "current-session"
        cs_path.write_text("session-x\n", encoding="utf-8")

        orig = Path.read_text
        def _fail_read_text(self, *args, **kwargs):
            if self == cs_path:
                raise OSError("simulated read error")
            return orig(self, *args, **kwargs)

        Path.read_text = _fail_read_text
        try:
            result = read_current_session(state)
        finally:
            Path.read_text = orig

        assert result["exists"] is True, result
        assert "error" in result, result
        assert "OSError" in result["error"], result
        assert "session_id" not in result, result


# ─── registry_summary() missing + invalid-shape paths ────────────────────────

def test_registry_summary_missing_registry():
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        state = Path(tmp_dir) / "state"
        state.mkdir()
        result = registry_summary(state, "session-x")
        assert result["exists"] is False, result
        assert result["parse_status"] == "missing", result
        assert result["error_type"] is None, result


def test_registry_summary_invalid_shape_list():
    """Registry JSON parses fine but is a list, not a dict."""
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        state = Path(tmp_dir) / "state"
        state.mkdir()
        (state / "registry.json").write_text(json.dumps([1, 2, 3]), encoding="utf-8")
        result = registry_summary(state, "session-x")
        assert result["exists"] is True, result
        assert result["parse_status"] == "invalid_shape", result
        assert result["session_count"] == 0, result
        assert result["current_session_in_registry"] is False, result
        assert result["unique_project_dir_hash_count"] == 0, result


def test_registry_summary_sessions_not_dict():
    """Registry is a dict but sessions is not a dict (e.g. a list)."""
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        state = Path(tmp_dir) / "state"
        state.mkdir()
        (state / "registry.json").write_text(
            json.dumps({"sessions": ["not", "a", "dict"]}), encoding="utf-8"
        )
        result = registry_summary(state, "session-x")
        assert result["exists"] is True, result
        assert result["parse_status"] == "ok", result
        assert result["session_count"] == 0, result


# ─── SQLite helpers: column_exists error, count_rows branches ─────────────────

def test_count_rows_missing_table_returns_missing_status():
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        db = Path(tmp_dir) / "tmup.db"
        con = sqlite3.connect(str(db))
        con.execute("CREATE TABLE tasks (id TEXT)")
        con.commit()
        con.close()

        con2 = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        cur = con2.cursor()
        result = count_rows(cur, "nonexistent_table_xyz")
        con2.close()

        assert result["status"] == "missing_table", result
        assert result["count"] is None, result


def test_grouped_counts_missing_table_returns_empty_dict():
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        db = Path(tmp_dir) / "tmup.db"
        con = sqlite3.connect(str(db))
        con.execute("CREATE TABLE tasks (id TEXT, status TEXT)")
        con.commit()
        con.close()

        con2 = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        cur = con2.cursor()
        result = grouped_counts(cur, "nonexistent_table_xyz", "status")
        con2.close()

        assert result == {}, result


def test_grouped_counts_missing_column_returns_empty_dict():
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        db = Path(tmp_dir) / "tmup.db"
        con = sqlite3.connect(str(db))
        con.execute("CREATE TABLE tasks (id TEXT, status TEXT)")
        con.commit()
        con.close()

        con2 = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        cur = con2.cursor()
        result = grouped_counts(cur, "tasks", "nonexistent_column_xyz")
        con2.close()

        assert result == {}, result


# ─── inspect_db() path-missing branch ────────────────────────────────────────

def test_inspect_db_missing_db_file_returns_exists_false():
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        db = Path(tmp_dir) / "nosession" / "tmup.db"
        result = inspect_db(db, "some-session-id")
        assert result["exists"] is False, result
        assert result["path"] == str(db), result
        assert "open_status" not in result, result


# ─── inspect_db() exception on open ──────────────────────────────────────────

def test_inspect_db_corrupt_file_reports_error():
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        session_dir = Path(tmp_dir) / "session-bad"
        session_dir.mkdir()
        db = session_dir / "tmup.db"
        db.write_bytes(b"THIS IS NOT SQLITE DATA AT ALL XXX")
        result = inspect_db(db, "session-bad")
        assert result["exists"] is True, result
        assert result["open_status"] == "error", result
        assert "error" in result, result


# ─── inspect_db() is_current flag, schema_version absent ─────────────────────

def test_inspect_db_marks_is_current_true_when_session_matches():
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        session_dir = Path(tmp_dir) / "session-abc"
        session_dir.mkdir()
        db = session_dir / "tmup.db"
        con = sqlite3.connect(str(db))
        con.execute("CREATE TABLE tasks (id TEXT, status TEXT)")
        con.commit()
        con.close()

        result = inspect_db(db, "session-abc")
        assert result["is_current"] is True, result
        assert result["open_status"] == "ok", result
        assert result["schema_version"] is None, result  # no schema_version table


def test_inspect_db_marks_is_current_false_when_session_differs():
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        session_dir = Path(tmp_dir) / "session-abc"
        session_dir.mkdir()
        db = session_dir / "tmup.db"
        con = sqlite3.connect(str(db))
        con.execute("CREATE TABLE tasks (id TEXT, status TEXT)")
        con.commit()
        con.close()

        result = inspect_db(db, "session-xyz")
        assert result["is_current"] is False, result


# ─── db_summaries() current_path injection ───────────────────────────────────

def test_db_summaries_always_includes_current_session_db():
    """current_path not found in path glob but exists: must be appended."""
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        state = Path(tmp_dir) / "state"

        # Two older sessions (no DB)
        for s in ("session-old1", "session-old2"):
            (state / s).mkdir(parents=True)

        # Current session has a DB
        current_dir = state / "session-current"
        current_dir.mkdir(parents=True)
        db = current_dir / "tmup.db"
        con = sqlite3.connect(str(db))
        con.execute("CREATE TABLE tasks (id TEXT, status TEXT)")
        con.commit()
        con.close()

        # max_dbs=0 → None → all paths; but glob only finds dbs,
        # and session-old dirs have no db so glob returns only 1 path
        result = db_summaries(state, "session-current", max_dbs=1)
        # db_count_total counts all tmup.db glob hits = 1 (only current has one)
        assert result["db_count_total"] == 1, result

        # Now test the injection: limit to 0 selected but current is forced in
        # Build state with two DBs, limit to 1 to force injection
        session_dir2 = state / "session-second"
        session_dir2.mkdir(parents=True)
        db2 = session_dir2 / "tmup.db"
        con2 = sqlite3.connect(str(db2))
        con2.execute("CREATE TABLE tasks (id TEXT, status TEXT)")
        con2.commit()
        con2.close()

        # With max_dbs=1, sorted picks first (alpha); current not first → injected
        result2 = db_summaries(state, "session-current", max_dbs=1)
        assert result2["db_count_total"] == 2, result2
        paths_in_result = [d["path"] for d in result2["databases"]]
        assert str(db) in paths_in_result, result2


def test_db_summaries_current_session_none():
    """current_session_id=None: no injection, just returns found paths."""
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        state = Path(tmp_dir) / "state"
        session_dir = state / "session-a"
        session_dir.mkdir(parents=True)
        db = session_dir / "tmup.db"
        con = sqlite3.connect(str(db))
        con.execute("CREATE TABLE tasks (id TEXT)")
        con.commit()
        con.close()

        result = db_summaries(state, None, max_dbs=None)
        assert result["db_count_total"] == 1, result
        assert result["db_count_inspected"] == 1, result


def test_db_summaries_empty_state_root():
    """state_root doesn't exist: should return empty result."""
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        state = Path(tmp_dir) / "no-such-state"
        result = db_summaries(state, None, max_dbs=None)
        assert result["db_count_total"] == 0, result
        assert result["db_count_inspected"] == 0, result
        assert result["databases"] == [], result


# ─── source_schema_summary() with missing files ───────────────────────────────

def test_source_schema_summary_missing_files():
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        plugin = Path(tmp_dir) / "empty-plugin"
        plugin.mkdir()
        result = source_schema_summary(plugin)
        assert result["schema_sql_read_status"] == "error", result
        assert result["migrations_read_status"] == "error", result
        assert result["db_init_read_status"] == "error", result
        assert result["schema_sql_sha256_16"] is None, result
        assert result["schema_sql_tables"] == [], result
        assert result["migration_versions_declared"] == [], result
        assert result["migration_latest_declared"] is None, result


# ─── main() entry point: inline call (not subprocess) ────────────────────────

def test_main_emits_valid_json_with_schema_key():
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        tmp = Path(tmp_dir)
        plugin = make_plugin_root(tmp)
        state = make_state_root(tmp)

        orig_argv = sys.argv
        sys.argv = [
            "tmup_dag_schema_probe.py",
            "--plugin-root", str(plugin),
            "--state-root", str(state),
        ]
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                rc = main()
        finally:
            sys.argv = orig_argv

        assert rc == 0, rc
        report = json.loads(buf.getvalue())
        assert report["schema"] == "agent-runtime-tmup-dag-schema", report
        assert report["schema_version"] == "0.1", report
        assert "redaction" in report, report
        assert "verdict" in report, report
        assert report["sqlite"]["db_count_total"] == 1, report


def test_main_max_dbs_zero_means_no_limit():
    """--max-dbs 0 should translate to None (inspect all)."""
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        tmp = Path(tmp_dir)
        plugin = make_plugin_root(tmp)
        state = make_state_root(tmp)

        orig_argv = sys.argv
        sys.argv = [
            "tmup_dag_schema_probe.py",
            "--plugin-root", str(plugin),
            "--state-root", str(state),
            "--max-dbs", "0",
        ]
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                rc = main()
        finally:
            sys.argv = orig_argv

        assert rc == 0, rc
        report = json.loads(buf.getvalue())
        assert report["sqlite"]["inspection_limit"] is None, report


def test_main_pretty_flag_emits_indented_json():
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        tmp = Path(tmp_dir)
        plugin = make_plugin_root(tmp)
        state = make_state_root(tmp)

        orig_argv = sys.argv
        sys.argv = [
            "tmup_dag_schema_probe.py",
            "--plugin-root", str(plugin),
            "--state-root", str(state),
            "--pretty",
        ]
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                rc = main()
        finally:
            sys.argv = orig_argv

        assert rc == 0, rc
        output = buf.getvalue()
        # Indented JSON has newlines within the body
        assert "\n  " in output, "expected pretty-printed indented output"
        report = json.loads(output)
        assert report["schema"] == "agent-runtime-tmup-dag-schema", report


def test_main_no_current_session_no_crash():
    """State root without current-session file should not crash main()."""
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        tmp = Path(tmp_dir)
        plugin = make_plugin_root(tmp)
        state = tmp / "empty-state"
        state.mkdir()

        orig_argv = sys.argv
        sys.argv = [
            "tmup_dag_schema_probe.py",
            "--plugin-root", str(plugin),
            "--state-root", str(state),
        ]
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                rc = main()
        finally:
            sys.argv = orig_argv

        assert rc == 0, rc
        report = json.loads(buf.getvalue())
        assert report["current_session"]["exists"] is False, report
        assert report["registry"]["parse_status"] == "missing", report


# ─── column_exists() sqlite3.Error path (lines 209-210) ─────────────────────

def test_column_exists_returns_false_on_sqlite_error():
    """Force sqlite3.Error inside column_exists via a wrapping cursor proxy."""
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        db = Path(tmp_dir) / "tmup.db"
        con = sqlite3.connect(str(db))
        con.execute("CREATE TABLE tasks (id TEXT, status TEXT)")
        con.commit()

        real_cur = con.cursor()

        class _ErrorCursor:
            """Cursor proxy: PRAGMA calls raise sqlite3.Error; all else delegates."""
            def execute(self, sql, *args, **kwargs):
                if "PRAGMA" in sql.upper():
                    raise sqlite3.OperationalError("simulated pragma error")
                return real_cur.execute(sql, *args, **kwargs)
            def fetchall(self):
                return real_cur.fetchall()
            def fetchone(self):
                return real_cur.fetchone()

        result = column_exists(_ErrorCursor(), "tasks", "status")
        con.close()

        assert result is False, result


# ─── count_rows() sqlite3.Error path (lines 218-219) ─────────────────────────

def test_count_rows_returns_error_status_on_sqlite_error():
    """Force sqlite3.Error inside count_rows via a wrapping cursor proxy."""
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        db = Path(tmp_dir) / "tmup.db"
        con = sqlite3.connect(str(db))
        con.execute("CREATE TABLE tasks (id TEXT, status TEXT)")
        con.commit()

        real_cur = con.cursor()

        class _ErrorCursor:
            """Cursor proxy: COUNT(*) queries raise sqlite3.Error; sqlite_master queries pass through."""
            def execute(self, sql, *args, **kwargs):
                if "COUNT" in sql.upper():
                    raise sqlite3.OperationalError("simulated count error")
                return real_cur.execute(sql, *args, **kwargs)
            def fetchall(self):
                return real_cur.fetchall()
            def fetchone(self):
                return real_cur.fetchone()

        result = count_rows(_ErrorCursor(), "tasks")
        con.close()

        assert result["status"] == "error", result
        assert result["count"] is None, result
        assert result["error_type"] == "OperationalError", result


# ─── db_summaries() line 299: current_path injected when beyond limit ─────────

def test_db_summaries_injects_current_session_when_beyond_limit():
    """With 2 DBs sorted alpha, limit=1 picks the first; current=second must be appended."""
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        state = Path(tmp_dir) / "state"

        # "session-aaa" sorts before "session-zzz"
        for name in ("session-aaa", "session-zzz"):
            d = state / name
            d.mkdir(parents=True)
            con = sqlite3.connect(str(d / "tmup.db"))
            con.execute("CREATE TABLE tasks (id TEXT, status TEXT)")
            con.commit()
            con.close()

        # current = session-zzz (sorts second); limit=1 picks only session-aaa
        result = db_summaries(state, "session-zzz", max_dbs=1)

        # Both should appear: 1 from limit + 1 injected
        assert result["db_count_total"] == 2, result
        assert result["db_count_inspected"] == 2, result
        paths_in_result = [d["path"] for d in result["databases"]]
        current_db = str(state / "session-zzz" / "tmup.db")
        assert current_db in paths_in_result, result


# ─── main() BrokenPipeError path (lines 352-356) ─────────────────────────────

def test_main_broken_pipe_returns_zero():
    """json.dump raises BrokenPipeError — main() catches it and returns 0."""
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        tmp = Path(tmp_dir)
        plugin = make_plugin_root(tmp)
        state = make_state_root(tmp)

        orig_argv = sys.argv
        sys.argv = [
            "tmup_dag_schema_probe.py",
            "--plugin-root", str(plugin),
            "--state-root", str(state),
        ]

        import json as _json
        orig_dump = _json.dump

        def _raise_broken_pipe(*args, **kwargs):
            raise BrokenPipeError("simulated broken pipe")

        buf = io.StringIO()
        try:
            _json.dump = _raise_broken_pipe
            with redirect_stdout(buf):
                rc = main()
        finally:
            sys.argv = orig_argv
            _json.dump = orig_dump

        assert rc == 0, rc


def test_main_broken_pipe_stdout_close_oserror_returns_one():
    """BrokenPipeError caught; sys.stdout.close() raises OSError → return 1."""
    with tempfile.TemporaryDirectory(prefix="tmup-probe-test-") as tmp_dir:
        tmp = Path(tmp_dir)
        plugin = make_plugin_root(tmp)
        state = make_state_root(tmp)

        orig_argv = sys.argv
        sys.argv = [
            "tmup_dag_schema_probe.py",
            "--plugin-root", str(plugin),
            "--state-root", str(state),
        ]

        import json as _json
        orig_dump = _json.dump

        def _raise_broken_pipe(*args, **kwargs):
            raise BrokenPipeError("simulated broken pipe")

        class _FailCloseStdout:
            """stdout replacement: write is no-op, close() raises OSError."""
            def write(self, s):
                pass
            def close(self):
                raise OSError("simulated close error")

        orig_stdout = sys.stdout
        buf = io.StringIO()
        try:
            _json.dump = _raise_broken_pipe
            sys.stdout = _FailCloseStdout()
            rc = main()
        finally:
            sys.argv = orig_argv
            sys.stdout = orig_stdout
            _json.dump = orig_dump

        assert rc == 1, rc


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} tmup DAG schema probe tests passed")
