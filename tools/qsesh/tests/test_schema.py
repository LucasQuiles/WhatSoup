"""T17 SQLite schema-v1 and connection invariant contracts."""

from __future__ import annotations

import json
import sqlite3
import stat
from pathlib import Path

import pytest
from qsesh.errors import QseshError
from qsesh.schema import (
    APPLICATION_ID,
    BUSY_TIMEOUT_MS,
    CURRENT_SCHEMA_VERSION,
    SCHEMA_SHA256,
    normalized_schema,
    open_database,
    schema_checksum,
)

EXPECTED_TABLES = {
    "archives",
    "cursors",
    "ingest_errors",
    "ingest_runs",
    "migrations",
    "session_compactions",
    "session_files",
    "session_metrics",
    "session_skills",
    "session_subagents",
    "session_tools",
    "sessions",
    "transcript_documents",
    "transcript_turns",
    "transcripts",
}
EXPECTED_INDEXES = {
    "idx_ingest_errors_run",
    "idx_session_metrics_grouping",
    "idx_sessions_project",
    "idx_sessions_started",
}
EXPECTED_TRIGGERS = {
    "transcript_documents_ad",
    "transcript_documents_ai",
    "transcript_documents_au",
}


def _objects(connection: sqlite3.Connection, kind: str) -> set[str]:
    return {
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' AND name NOT GLOB 'transcripts_*'",
            (kind,),
        )
    }


def _columns(
    connection: sqlite3.Connection, table: str
) -> dict[str, tuple[str, int, int]]:
    return {
        row[1]: (row[2], row[3], row[5])
        for row in connection.execute(f"PRAGMA table_info({table})")
    }


def _seed_session(
    connection: sqlite3.Connection,
    *,
    qid: str = "qs-abcdefghij",
    digest: bytes = b"d" * 32,
    native_id: str = "native-1",
) -> None:
    source_digest = "a" * 64
    relpath = f"archive/claude/{qid}/{source_digest}.jsonl.gz"
    connection.execute(
        "INSERT INTO archives(relpath,harness,qid,source_digest,sha256,byte_count,accepted_at_us) VALUES(?,?,?,?,?,?,?)",
        (relpath, "claude", qid, source_digest, "b" * 64, 10, 1),
    )
    connection.execute(
        "INSERT INTO sessions(qid,identity_digest,host_id,harness,native_id,project,started_at_us,ended_at_us,duration_us,source_pointer,source_digest,archive_relpath,archive_sha256,archive_byte_count,record_json,updated_at_us) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            qid,
            digest,
            "host-1",
            "claude",
            native_id,
            "project",
            1,
            2,
            1,
            "source-key",
            source_digest,
            relpath,
            "b" * 64,
            10,
            json.dumps({"qid": qid}),
            2,
        ),
    )


def test_fresh_schema_has_exact_objects_columns_versions_and_checksum(
    tmp_path: Path,
) -> None:
    path = tmp_path / "data/qsesh.db"
    connection = open_database(path)
    try:
        assert APPLICATION_ID == 0x51534553
        assert (
            SCHEMA_SHA256
            == "0bdb585c87f3020325985ac99a89101fc68aeb048a7af8607692346e5d6ee48c"
        )
        assert (
            connection.execute("PRAGMA application_id").fetchone()[0] == APPLICATION_ID
        )
        assert (
            connection.execute("PRAGMA user_version").fetchone()[0]
            == CURRENT_SCHEMA_VERSION
            == 1
        )
        tables = _objects(connection, "table")
        assert EXPECTED_TABLES <= tables
        assert {
            name for name in tables if not name.startswith("transcripts_")
        } == EXPECTED_TABLES
        assert _objects(connection, "trigger") == EXPECTED_TRIGGERS
        indexes = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL"
            )
        }
        assert indexes == EXPECTED_INDEXES
        assert _columns(connection, "sessions")["qid"] == ("TEXT", 1, 1)
        assert _columns(connection, "sessions")["identity_digest"] == ("BLOB", 1, 0)
        assert _columns(connection, "transcript_turns")["turn_index"] == (
            "INTEGER",
            1,
            2,
        )
        assert _columns(connection, "archives")["relpath"] == ("TEXT", 1, 1)
        assert schema_checksum(connection) == SCHEMA_SHA256
        assert normalized_schema(connection)
    finally:
        connection.close()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700


def test_connection_pragmas_are_read_back_not_assumed(tmp_path: Path) -> None:
    connection = open_database(tmp_path / "qsesh.db")
    try:
        assert connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert connection.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
        assert connection.execute("PRAGMA synchronous").fetchone()[0] == 2
        assert (
            connection.execute("PRAGMA busy_timeout").fetchone()[0]
            == BUSY_TIMEOUT_MS
            == 5000
        )
        assert connection.execute("PRAGMA trusted_schema").fetchone()[0] == 0
    finally:
        connection.close()


def test_unique_identity_qid_digest_and_foreign_key_constraints(tmp_path: Path) -> None:
    connection = open_database(tmp_path / "qsesh.db")
    try:
        _seed_session(connection)
        with pytest.raises(sqlite3.IntegrityError):
            _seed_session(
                connection, qid="qs-bbbbbbbbbb", digest=b"e" * 32, native_id="native-1"
            )
        with pytest.raises(sqlite3.IntegrityError):
            _seed_session(
                connection, qid="qs-cccccccccc", digest=b"d" * 32, native_id="native-2"
            )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO transcript_turns(qid,turn_index,role,timestamp_utc,text) VALUES('qs-bbbbbbbbbb',0,'user',NULL,'x')"
            )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "UPDATE sessions SET qid='bad' WHERE qid='qs-abcdefghij'"
            )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "UPDATE sessions SET identity_digest=x'00' WHERE qid='qs-abcdefghij'"
            )
    finally:
        connection.close()


def test_external_content_fts_tracks_insert_update_and_cascade_delete(
    tmp_path: Path,
) -> None:
    connection = open_database(tmp_path / "qsesh.db")
    try:
        _seed_session(connection)
        connection.execute(
            "INSERT INTO transcript_documents(qid,text) VALUES(?,?)",
            ("qs-abcdefghij", "alpha phrase"),
        )
        assert connection.execute(
            "SELECT qid FROM transcripts WHERE transcripts MATCH 'alpha'"
        ).fetchall() == [("qs-abcdefghij",)]
        connection.execute(
            "UPDATE transcript_documents SET text='beta phrase' WHERE qid='qs-abcdefghij'"
        )
        assert (
            connection.execute(
                "SELECT count(*) FROM transcripts WHERE transcripts MATCH 'alpha'"
            ).fetchone()[0]
            == 0
        )
        assert (
            connection.execute(
                "SELECT count(*) FROM transcripts WHERE transcripts MATCH 'beta'"
            ).fetchone()[0]
            == 1
        )
        connection.execute("DELETE FROM sessions WHERE qid='qs-abcdefghij'")
        assert (
            connection.execute("SELECT count(*) FROM transcript_documents").fetchone()[
                0
            ]
            == 0
        )
        assert (
            connection.execute(
                "SELECT count(*) FROM transcripts WHERE transcripts MATCH 'beta'"
            ).fetchone()[0]
            == 0
        )
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert connection.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    finally:
        connection.close()


@pytest.mark.parametrize("case", ["wrong-application", "newer-version", "drift"])
def test_existing_wrong_or_newer_database_is_rejected_before_ddl(
    tmp_path: Path, case: str
) -> None:
    path = tmp_path / f"{case}.db"
    raw = sqlite3.connect(path)
    raw.execute("CREATE TABLE sentinel(value TEXT)")
    raw.execute("INSERT INTO sentinel VALUES('untouched')")
    if case == "wrong-application":
        raw.execute("PRAGMA application_id=123")
    else:
        raw.execute(f"PRAGMA application_id={APPLICATION_ID}")
        raw.execute(f"PRAGMA user_version={2 if case == 'newer-version' else 1}")
    raw.commit()
    raw.close()
    before = path.read_bytes()

    with pytest.raises(QseshError) as caught:
        open_database(path)
    assert caught.value.code == "QS-E-MIGRATION"
    assert caught.value.phase in {
        "schema-application-id",
        "schema-newer-version",
        "schema-drift",
    }
    check = sqlite3.connect(path)
    assert check.execute("SELECT * FROM sentinel").fetchall() == [("untouched",)]
    assert not (EXPECTED_TABLES - {"transcripts"}) & _objects(check, "table")
    check.close()
    assert path.read_bytes() == before


def test_schema_module_contains_no_source_or_episodic_paths_or_dynamic_identifiers() -> (
    None
):
    source = (Path(__file__).parents[1] / "qsesh/schema.py").read_text()
    assert "episodic" not in source
    assert "qsesh.sources" not in source
    assert "SELECT name FROM" not in source
