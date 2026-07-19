"""T17 SQLite schema-v2 and connection invariant contracts."""

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
    V1_SCHEMA_SHA256,
    _MIGRATION_2_NAME,
    _V1_DDL,
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
    "session_size_metrics",
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
EXPECTED_VIEWS = {
    "session_content_reduction",
    "corpus_size_totals",
    "corpus_reduction_by_harness",
    "corpus_reduction_by_project",
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


def _seed_size_metrics(
    connection: sqlite3.Connection,
    qid: str,
    metrics_version: str,
    dimension: str,
    original: int,
    clean: int,
) -> None:
    connection.execute(
        "INSERT INTO session_size_metrics(qid,side,dimension,value,metrics_version) VALUES(?,?,?,?,?)",
        (qid, "content_original", dimension, original, metrics_version),
    )
    connection.execute(
        "INSERT INTO session_size_metrics(qid,side,dimension,value,metrics_version) VALUES(?,?,?,?,?)",
        (qid, "content_clean", dimension, clean, metrics_version),
    )


def _build_raw_v1_database(path: Path) -> None:
    """Build a genuine v1 DB by hand (bypassing open_database, which now speaks v2)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
        connection.execute("PRAGMA trusted_schema=OFF")
        for statement in _V1_DDL:
            connection.execute(statement)
        connection.execute(f"PRAGMA application_id={APPLICATION_ID}")
        connection.execute("PRAGMA user_version=1")
        connection.commit()
    finally:
        connection.close()


def test_fresh_schema_has_exact_objects_columns_versions_and_checksum(
    tmp_path: Path,
) -> None:
    path = tmp_path / "data/qsesh.db"
    connection = open_database(path)
    try:
        assert APPLICATION_ID == 0x51534553
        assert (
            SCHEMA_SHA256
            == "54750f703858ca3d7088c1e5c9e1024920142f043716df9ea62bba01b4c4eb30"
        )
        assert (
            connection.execute("PRAGMA application_id").fetchone()[0] == APPLICATION_ID
        )
        assert (
            connection.execute("PRAGMA user_version").fetchone()[0]
            == CURRENT_SCHEMA_VERSION
            == 2
        )
        tables = _objects(connection, "table")
        assert EXPECTED_TABLES <= tables
        assert {
            name for name in tables if not name.startswith("transcripts_")
        } == EXPECTED_TABLES
        assert _objects(connection, "trigger") == EXPECTED_TRIGGERS
        assert _objects(connection, "view") == EXPECTED_VIEWS
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
        assert connection.execute("SELECT count(*) FROM migrations").fetchone()[0] == 0
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
        raw.execute(f"PRAGMA user_version={3 if case == 'newer-version' else 1}")
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


def test_migrate_v1_to_v2(tmp_path: Path) -> None:
    path = tmp_path / "data/qsesh.db"
    _build_raw_v1_database(path)
    verify = sqlite3.connect(path)
    try:
        assert schema_checksum(verify) == V1_SCHEMA_SHA256
    finally:
        verify.close()

    connection = open_database(path)
    try:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 2
        assert "session_size_metrics" in _objects(connection, "table")
        assert _objects(connection, "view") == EXPECTED_VIEWS
        rows = connection.execute(
            "SELECT version,name,checksum,applied_at_us FROM migrations"
        ).fetchall()
        assert len(rows) == 1
        version, name, checksum, applied_at_us = rows[0]
        assert version == 2
        assert name == _MIGRATION_2_NAME
        assert checksum == SCHEMA_SHA256
        assert applied_at_us >= 0
        assert schema_checksum(connection) == SCHEMA_SHA256
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert connection.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    finally:
        connection.close()


def test_fresh_and_migrated_fingerprints_match(tmp_path: Path) -> None:
    fresh = open_database(tmp_path / "fresh/qsesh.db")
    try:
        fresh_checksum = schema_checksum(fresh)
    finally:
        fresh.close()

    migrated_path = tmp_path / "migrated/qsesh.db"
    _build_raw_v1_database(migrated_path)
    migrated = open_database(migrated_path)
    try:
        migrated_checksum = schema_checksum(migrated)
    finally:
        migrated.close()

    assert fresh_checksum == migrated_checksum == SCHEMA_SHA256


def test_reopen_is_idempotent(tmp_path: Path) -> None:
    path = tmp_path / "data/qsesh.db"
    first = open_database(path)
    first.close()
    second = open_database(path)
    try:
        assert second.execute("PRAGMA user_version").fetchone()[0] == 2
        assert schema_checksum(second) == SCHEMA_SHA256
        assert second.execute("SELECT count(*) FROM migrations").fetchone()[0] == 0
    finally:
        second.close()


def test_session_content_reduction_view_computes_real_division_ratio(
    tmp_path: Path,
) -> None:
    connection = open_database(tmp_path / "qsesh.db")
    try:
        _seed_session(connection)
        _seed_size_metrics(connection, "qs-abcdefghij", "m1", "char", 100, 25)
        row = connection.execute(
            "SELECT qid,metrics_version,dimension,original,clean,delta,reduction_ratio "
            "FROM session_content_reduction WHERE qid='qs-abcdefghij'"
        ).fetchone()
        assert row == ("qs-abcdefghij", "m1", "char", 100, 25, 75, 0.75)
        assert isinstance(row[6], float)
    finally:
        connection.close()


def test_session_content_reduction_view_ratio_is_null_on_zero_original(
    tmp_path: Path,
) -> None:
    connection = open_database(tmp_path / "qsesh.db")
    try:
        _seed_session(connection)
        _seed_size_metrics(connection, "qs-abcdefghij", "m1", "char", 0, 0)
        row = connection.execute(
            "SELECT delta,reduction_ratio FROM session_content_reduction "
            "WHERE qid='qs-abcdefghij'"
        ).fetchone()
        assert row == (0, None)
    finally:
        connection.close()


def test_session_content_reduction_view_allows_unclamped_negative_delta(
    tmp_path: Path,
) -> None:
    connection = open_database(tmp_path / "qsesh.db")
    try:
        _seed_session(connection)
        _seed_size_metrics(connection, "qs-abcdefghij", "m1", "char", 10, 30)
        row = connection.execute(
            "SELECT delta,reduction_ratio FROM session_content_reduction "
            "WHERE qid='qs-abcdefghij'"
        ).fetchone()
        assert row[0] == -20
        assert row[1] == pytest.approx(-2.0)
        assert isinstance(row[1], float)
    finally:
        connection.close()


def test_corpus_size_totals_sums_value_by_group(tmp_path: Path) -> None:
    connection = open_database(tmp_path / "qsesh.db")
    try:
        _seed_session(connection, qid="qs-abcdefghij", digest=b"d" * 32, native_id="n1")
        _seed_session(connection, qid="qs-bbbbbbbbbb", digest=b"e" * 32, native_id="n2")
        _seed_size_metrics(connection, "qs-abcdefghij", "m1", "char", 100, 25)
        _seed_size_metrics(connection, "qs-bbbbbbbbbb", "m1", "char", 50, 10)
        total_original = connection.execute(
            "SELECT total FROM corpus_size_totals "
            "WHERE metrics_version='m1' AND dimension='char' AND side='content_original'"
        ).fetchone()[0]
        total_clean = connection.execute(
            "SELECT total FROM corpus_size_totals "
            "WHERE metrics_version='m1' AND dimension='char' AND side='content_clean'"
        ).fetchone()[0]
        assert total_original == 150
        assert total_clean == 35
    finally:
        connection.close()


def test_corpus_reduction_by_harness_aggregates_before_dividing(
    tmp_path: Path,
) -> None:
    connection = open_database(tmp_path / "qsesh.db")
    try:
        _seed_session(connection, qid="qs-abcdefghij", digest=b"d" * 32, native_id="n1")
        _seed_session(connection, qid="qs-bbbbbbbbbb", digest=b"e" * 32, native_id="n2")
        _seed_size_metrics(connection, "qs-abcdefghij", "m1", "char", 100, 50)
        _seed_size_metrics(connection, "qs-bbbbbbbbbb", "m1", "char", 300, 100)
        row = connection.execute(
            "SELECT original,clean,delta,reduction_ratio FROM corpus_reduction_by_harness "
            "WHERE metrics_version='m1' AND harness='claude' AND dimension='char'"
        ).fetchone()
        # aggregate-first: (100+300)-(50+100) over (100+300), NOT the average of
        # the two per-session ratios (0.5 and 0.667).
        assert row == (400, 150, 250, 0.625)
        assert isinstance(row[3], float)
    finally:
        connection.close()


def test_corpus_reduction_by_project_aggregates_before_dividing(
    tmp_path: Path,
) -> None:
    connection = open_database(tmp_path / "qsesh.db")
    try:
        _seed_session(connection, qid="qs-abcdefghij", digest=b"d" * 32, native_id="n1")
        _seed_session(connection, qid="qs-bbbbbbbbbb", digest=b"e" * 32, native_id="n2")
        _seed_size_metrics(connection, "qs-abcdefghij", "m1", "char", 100, 50)
        _seed_size_metrics(connection, "qs-bbbbbbbbbb", "m1", "char", 300, 100)
        row = connection.execute(
            "SELECT original,clean,delta,reduction_ratio FROM corpus_reduction_by_project "
            "WHERE metrics_version='m1' AND project='project' AND dimension='char'"
        ).fetchone()
        assert row == (400, 150, 250, 0.625)
        assert isinstance(row[3], float)
    finally:
        connection.close()


def test_session_size_metrics_rejects_invalid_dimension(tmp_path: Path) -> None:
    connection = open_database(tmp_path / "qsesh.db")
    try:
        _seed_session(connection)
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO session_size_metrics(qid,side,dimension,value,metrics_version) VALUES(?,?,?,?,?)",
                ("qs-abcdefghij", "content_original", "not-a-dimension", 10, "m1"),
            )
    finally:
        connection.close()


def test_session_size_metrics_rejects_negative_value(tmp_path: Path) -> None:
    connection = open_database(tmp_path / "qsesh.db")
    try:
        _seed_session(connection)
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO session_size_metrics(qid,side,dimension,value,metrics_version) VALUES(?,?,?,?,?)",
                ("qs-abcdefghij", "content_original", "char", -1, "m1"),
            )
    finally:
        connection.close()


def test_session_size_metrics_rejects_empty_metrics_version(tmp_path: Path) -> None:
    connection = open_database(tmp_path / "qsesh.db")
    try:
        _seed_session(connection)
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO session_size_metrics(qid,side,dimension,value,metrics_version) VALUES(?,?,?,?,?)",
                ("qs-abcdefghij", "content_original", "char", 10, ""),
            )
    finally:
        connection.close()


def test_migration_rolls_back_completely_on_failure_after_ddl(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "data/qsesh.db"
    _build_raw_v1_database(path)

    def _boom() -> int:
        raise RuntimeError("injected failure after DDL, before commit")

    monkeypatch.setattr("qsesh.schema.time.time_ns", _boom)

    with pytest.raises(RuntimeError, match="injected failure"):
        open_database(path)

    verify = sqlite3.connect(path)
    try:
        assert verify.execute("PRAGMA user_version").fetchone()[0] == 1
        assert "session_size_metrics" not in _objects(verify, "table")
        assert (
            verify.execute(
                "SELECT count(*) FROM migrations WHERE version=2"
            ).fetchone()[0]
            == 0
        )
    finally:
        verify.close()


def test_reopen_rejects_v2_checksum_drift(tmp_path: Path) -> None:
    path = tmp_path / "qsesh.db"
    connection = open_database(path)
    connection.close()

    raw = sqlite3.connect(path)
    try:
        raw.execute("CREATE VIEW session_size_metrics_drift_probe AS SELECT 1 AS one")
        raw.commit()
    finally:
        raw.close()

    check = sqlite3.connect(path)
    try:
        assert check.execute("PRAGMA user_version").fetchone()[0] == 2
    finally:
        check.close()

    with pytest.raises(QseshError) as caught:
        open_database(path)
    assert caught.value.code == "QS-E-MIGRATION"
    assert caught.value.phase == "schema-drift"


def test_schema_module_contains_no_source_or_episodic_paths_or_dynamic_identifiers() -> (
    None
):
    source = (Path(__file__).parents[1] / "qsesh/schema.py").read_text()
    assert "episodic" not in source
    assert "qsesh.sources" not in source
    assert "SELECT name FROM" not in source
