"""T17 SQLite schema-v2 and connection invariant contracts."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import stat
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
import qsesh.schema as schema_module
from qsesh.errors import QseshError
from qsesh.schema import (
    APPLICATION_ID,
    BUSY_TIMEOUT_MS,
    CURRENT_SCHEMA_VERSION,
    SCHEMA_SHA256,
    V1_SCHEMA_SHA256,
    _MIGRATION_2_NAME,
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
V1_SCHEMA_FIXTURE = Path(__file__).parent / "fixtures/schema-v1.sql"
V1_SCHEMA_FIXTURE_SHA256 = (
    "506487723c802be97f037af0d10974e0fd6210fe89eff01e4113d4012abd346f"
)
V1_SCHEMA_ORACLE_SHA256 = (
    "0bdb585c87f3020325985ac99a89101fc68aeb048a7af8607692346e5d6ee48c"
)


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
    harness: str = "claude",
    project: str = "project",
) -> None:
    source_digest = "a" * 64
    relpath = f"archive/{harness}/{qid}/{source_digest}.jsonl.gz"
    connection.execute(
        "INSERT INTO archives(relpath,harness,qid,source_digest,sha256,byte_count,accepted_at_us) VALUES(?,?,?,?,?,?,?)",
        (relpath, harness, qid, source_digest, "b" * 64, 10, 1),
    )
    connection.execute(
        "INSERT INTO sessions(qid,identity_digest,host_id,harness,native_id,project,started_at_us,ended_at_us,duration_us,source_pointer,source_digest,archive_relpath,archive_sha256,archive_byte_count,record_json,updated_at_us) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            qid,
            digest,
            "host-1",
            harness,
            native_id,
            project,
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
        "INSERT INTO session_size_metrics(qid,side,dimension,value,metrics_version,unicode_version) VALUES(?,?,?,?,?,'16.0.0')",
        (qid, "content_original", dimension, original, metrics_version),
    )
    connection.execute(
        "INSERT INTO session_size_metrics(qid,side,dimension,value,metrics_version,unicode_version) VALUES(?,?,?,?,?,'16.0.0')",
        (qid, "content_clean", dimension, clean, metrics_version),
    )


def _build_raw_v1_database(path: Path) -> None:
    """Build v1 from the frozen, populated fixture, not production schema constants."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fixture_bytes = V1_SCHEMA_FIXTURE.read_bytes()
    assert hashlib.sha256(fixture_bytes).hexdigest() == V1_SCHEMA_FIXTURE_SHA256
    connection = sqlite3.connect(path)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
        connection.execute("PRAGMA trusted_schema=OFF")
        connection.executescript(fixture_bytes.decode("utf-8"))
    finally:
        connection.close()


def _open_two_after_matching_initial_inspection(
    path: Path, monkeypatch: pytest.MonkeyPatch
) -> list[int]:
    first_inspections = threading.Barrier(2)
    inspected_connections: set[int] = set()
    inspection_lock = threading.Lock()
    original_inspect = schema_module._inspect_existing

    def synchronized_inspect(
        connection: sqlite3.Connection,
    ) -> tuple[int, int, bool]:
        observed = original_inspect(connection)
        connection_id = id(connection)
        with inspection_lock:
            is_first = connection_id not in inspected_connections
            inspected_connections.add(connection_id)
        if is_first:
            first_inspections.wait(timeout=5)
        return observed

    monkeypatch.setattr(schema_module, "_inspect_existing", synchronized_inspect)

    def open_and_report_version() -> int:
        connection = open_database(path)
        try:
            return connection.execute("PRAGMA user_version").fetchone()[0]
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        return list(pool.map(lambda _: open_and_report_version(), range(2)))


def test_fresh_schema_has_exact_objects_columns_versions_and_checksum(
    tmp_path: Path,
) -> None:
    path = tmp_path / "data/qsesh.db"
    connection = open_database(path)
    try:
        assert APPLICATION_ID == 0x51534553
        assert (
            SCHEMA_SHA256
            == "7af29e7d72c072d1eb7078af0d9bd89f63225dadd0e28d516f1fbe924392df66"
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
        assert connection.execute(
            "SELECT version,name,checksum FROM migrations"
        ).fetchall() == [(2, _MIGRATION_2_NAME, SCHEMA_SHA256)]
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
        assert V1_SCHEMA_SHA256 == V1_SCHEMA_ORACLE_SHA256
        assert schema_checksum(verify) == V1_SCHEMA_ORACLE_SHA256
        assert verify.execute(
            "SELECT qid,harness,project FROM sessions"
        ).fetchall() == [("qs-abcdefghij", "claude", "fixture-project")]
        assert verify.execute(
            "SELECT qid,turn_index,role,text FROM transcript_turns"
        ).fetchall() == [("qs-abcdefghij", 0, "user", "fixture turn")]
        assert verify.execute(
            "SELECT qid,name,is_mcp,count,call_ids_json FROM session_tools"
        ).fetchall() == [("qs-abcdefghij", "fixture_tool", 0, 2, '["call-1","call-2"]')]
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
        assert connection.execute(
            "SELECT qid,harness,project FROM sessions"
        ).fetchall() == [("qs-abcdefghij", "claude", "fixture-project")]
        assert connection.execute(
            "SELECT qid,turn_index,role,text FROM transcript_turns"
        ).fetchall() == [("qs-abcdefghij", 0, "user", "fixture turn")]
        assert connection.execute(
            "SELECT qid,name,is_mcp,count,call_ids_json FROM session_tools"
        ).fetchall() == [("qs-abcdefghij", "fixture_tool", 0, 2, '["call-1","call-2"]')]
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert connection.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    finally:
        connection.close()


def test_two_concurrent_v1_openers_converge_on_one_migration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "data/qsesh.db"
    _build_raw_v1_database(path)
    versions = _open_two_after_matching_initial_inspection(path, monkeypatch)

    assert versions == [2, 2]
    verify = sqlite3.connect(path)
    try:
        assert schema_checksum(verify) == SCHEMA_SHA256
        assert verify.execute(
            "SELECT version,name,checksum FROM migrations"
        ).fetchall() == [(2, _MIGRATION_2_NAME, SCHEMA_SHA256)]
    finally:
        verify.close()


def test_v1_opener_rechecks_after_peer_migrates_between_inspect_and_checksum(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "data/qsesh.db"
    _build_raw_v1_database(path)
    slow_observed_v1 = threading.Event()
    release_slow = threading.Event()
    original_inspect = schema_module._inspect_existing

    def pause_slow_after_v1_inspection(
        connection: sqlite3.Connection,
    ) -> tuple[int, int, bool]:
        observed = original_inspect(connection)
        if (
            threading.current_thread().name.startswith("slow-v1")
            and observed[0] == APPLICATION_ID
            and observed[1] == 1
            and not slow_observed_v1.is_set()
        ):
            slow_observed_v1.set()
            assert release_slow.wait(timeout=5)
        return observed

    monkeypatch.setattr(
        schema_module, "_inspect_existing", pause_slow_after_v1_inspection
    )

    def open_and_report_version() -> int:
        connection = open_database(path)
        try:
            return connection.execute("PRAGMA user_version").fetchone()[0]
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="slow-v1") as pool:
        slow = pool.submit(open_and_report_version)
        assert slow_observed_v1.wait(timeout=5)
        try:
            fast = open_database(path)
            fast.close()
        finally:
            release_slow.set()
        assert slow.result(timeout=5) == 2


def test_two_concurrent_fresh_openers_converge_on_one_install(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "data/qsesh.db"
    versions = _open_two_after_matching_initial_inspection(path, monkeypatch)

    assert versions == [2, 2]
    verify = sqlite3.connect(path)
    try:
        assert schema_checksum(verify) == SCHEMA_SHA256
        assert verify.execute(
            "SELECT version,name,checksum FROM migrations"
        ).fetchall() == [(2, _MIGRATION_2_NAME, SCHEMA_SHA256)]
    finally:
        verify.close()


def test_failed_fresh_opener_does_not_delete_database_installed_by_peer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "data/qsesh.db"
    slow_reached_configure = threading.Event()
    release_slow = threading.Event()
    original_configure = schema_module._configure

    def fail_slow_configure(connection: sqlite3.Connection) -> None:
        if threading.current_thread().name.startswith("slow-fresh"):
            slow_reached_configure.set()
            assert release_slow.wait(timeout=5)
            raise schema_module._fail("schema-injected-failure")
        original_configure(connection)

    monkeypatch.setattr(schema_module, "_configure", fail_slow_configure)

    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="slow-fresh") as pool:
        slow = pool.submit(open_database, path)
        assert slow_reached_configure.wait(timeout=5)
        fast: sqlite3.Connection | None = None
        try:
            fast = open_database(path)
            release_slow.set()
            with pytest.raises(QseshError) as caught:
                slow.result(timeout=5)
            assert caught.value.phase == "schema-injected-failure"
            assert path.exists()
            assert fast.execute("PRAGMA user_version").fetchone()[0] == 2
            assert schema_checksum(fast) == SCHEMA_SHA256
        finally:
            release_slow.set()
            if fast is not None:
                fast.close()


def test_failed_new_install_leaves_a_recoverable_database(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "data/qsesh.db"
    original_record = schema_module._record_v2_migration
    attempts = 0

    def fail_first_record(connection: sqlite3.Connection) -> None:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("injected fresh-install failure")
        original_record(connection)

    monkeypatch.setattr(schema_module, "_record_v2_migration", fail_first_record)

    with pytest.raises(RuntimeError, match="fresh-install failure"):
        open_database(path)
    assert path.exists()
    for candidate in (path, Path(f"{path}-wal"), Path(f"{path}-shm")):
        if candidate.exists():
            assert stat.S_IMODE(candidate.stat().st_mode) == 0o600

    recovered = open_database(path)
    try:
        assert recovered.execute("PRAGMA user_version").fetchone()[0] == 2
        assert schema_checksum(recovered) == SCHEMA_SHA256
    finally:
        recovered.close()


def test_read_only_v1_database_fails_with_typed_migration_error_without_mutation(
    tmp_path: Path,
) -> None:
    path = tmp_path / "data/qsesh.db"
    _build_raw_v1_database(path)
    candidates = (path, Path(f"{path}-wal"), Path(f"{path}-shm"))
    before = {
        candidate.name: candidate.read_bytes()
        for candidate in candidates
        if candidate.exists()
    }
    path.chmod(0o400)
    try:
        with pytest.raises(QseshError) as caught:
            open_database(path)
        assert caught.value.code == "QS-E-MIGRATION"
        assert caught.value.phase == "migration-read-only"
        assert caught.value.__cause__ is None
        after = {
            candidate.name: candidate.read_bytes()
            for candidate in candidates
            if candidate.exists()
        }
        assert after == before
        assert stat.S_IMODE(path.stat().st_mode) == 0o400
    finally:
        path.chmod(0o600)

    verify = sqlite3.connect(path)
    try:
        assert verify.execute("PRAGMA user_version").fetchone()[0] == 1
        assert schema_checksum(verify) == V1_SCHEMA_SHA256
        assert verify.execute("SELECT count(*) FROM migrations").fetchone()[0] == 0
    finally:
        verify.close()


def test_read_only_v1_with_uncheckpointed_wal_fails_without_ignoring_wal_state(
    tmp_path: Path,
) -> None:
    path = tmp_path / "data/qsesh.db"
    _build_raw_v1_database(path)
    writer = sqlite3.connect(path)
    writer.execute("PRAGMA wal_autocheckpoint=0")
    writer.execute(
        "INSERT INTO cursors(host_id,harness,native_id,source_key,updated_at_us,source_digest,extractor_contract) "
        "VALUES(?,?,?,?,?,?,?)",
        ("host", "claude", "native", "source", 1, "a" * 64, "fixture-v1"),
    )
    writer.commit()
    wal_path = Path(f"{path}-wal")
    assert wal_path.stat().st_size > 0
    candidates = (path, wal_path, Path(f"{path}-shm"))
    before = {candidate.name: candidate.read_bytes() for candidate in candidates}
    path.chmod(0o400)
    try:
        with pytest.raises(QseshError) as caught:
            open_database(path)
        assert caught.value.code == "QS-E-MIGRATION"
        assert caught.value.phase == "schema-read-only-wal"
        after = {candidate.name: candidate.read_bytes() for candidate in candidates}
        assert after == before
    finally:
        path.chmod(0o600)
        writer.close()


def test_read_only_inspection_rejects_wal_appearing_during_observation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "data/qsesh.db"
    _build_raw_v1_database(path)
    before = path.read_bytes()
    original_validate = schema_module._validate_observed_schema

    def create_wal_after_inspection(
        connection: sqlite3.Connection, *, allow_state_retry: bool = True
    ) -> tuple[int, int, bool]:
        observed = original_validate(connection, allow_state_retry=allow_state_retry)
        Path(f"{path}-wal").write_bytes(b"appeared-during-read-only-inspection")
        return observed

    monkeypatch.setattr(
        schema_module, "_validate_observed_schema", create_wal_after_inspection
    )
    path.chmod(0o400)
    try:
        with pytest.raises(QseshError) as caught:
            open_database(path)
        assert caught.value.phase == "schema-read-only-wal"
        assert path.read_bytes() == before
    finally:
        path.chmod(0o600)


def test_fresh_and_migrated_fingerprints_match(tmp_path: Path) -> None:
    fresh = open_database(tmp_path / "fresh/qsesh.db")
    try:
        fresh_checksum = schema_checksum(fresh)
        fresh_ledger = fresh.execute(
            "SELECT version,name,checksum FROM migrations"
        ).fetchall()
    finally:
        fresh.close()

    migrated_path = tmp_path / "migrated/qsesh.db"
    _build_raw_v1_database(migrated_path)
    migrated = open_database(migrated_path)
    try:
        migrated_checksum = schema_checksum(migrated)
        migrated_ledger = migrated.execute(
            "SELECT version,name,checksum FROM migrations"
        ).fetchall()
    finally:
        migrated.close()

    assert fresh_checksum == migrated_checksum == SCHEMA_SHA256
    assert fresh_ledger == migrated_ledger == [(2, _MIGRATION_2_NAME, SCHEMA_SHA256)]


def test_reopen_is_idempotent(tmp_path: Path) -> None:
    path = tmp_path / "data/qsesh.db"
    first = open_database(path)
    first.close()
    second = open_database(path)
    try:
        assert second.execute("PRAGMA user_version").fetchone()[0] == 2
        assert schema_checksum(second) == SCHEMA_SHA256
        assert second.execute(
            "SELECT version,name,checksum FROM migrations"
        ).fetchall() == [(2, _MIGRATION_2_NAME, SCHEMA_SHA256)]
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


def test_reduction_views_preserve_incomplete_metric_pairs_as_null_reductions(
    tmp_path: Path,
) -> None:
    connection = open_database(tmp_path / "qsesh.db")
    try:
        _seed_session(connection, qid="qs-abcdefghij", digest=b"d" * 32, native_id="n1")
        _seed_session(connection, qid="qs-bbbbbbbbbb", digest=b"e" * 32, native_id="n2")
        connection.execute(
            "INSERT INTO session_size_metrics(qid,side,dimension,value,metrics_version,unicode_version) VALUES(?,?,?,?,?,'16.0.0')",
            ("qs-abcdefghij", "content_original", "char", 100, "m1"),
        )
        connection.execute(
            "INSERT INTO session_size_metrics(qid,side,dimension,value,metrics_version,unicode_version) VALUES(?,?,?,?,?,'16.0.0')",
            ("qs-bbbbbbbbbb", "content_clean", "char", 25, "m1"),
        )

        session_rows = connection.execute(
            "SELECT qid,original,clean,delta,reduction_ratio "
            "FROM session_content_reduction ORDER BY qid"
        ).fetchall()
        assert session_rows == [
            ("qs-abcdefghij", 100, None, None, None),
            ("qs-bbbbbbbbbb", None, 25, None, None),
        ]
        assert connection.execute(
            "SELECT side,total FROM corpus_size_totals "
            "WHERE metrics_version='m1' AND dimension='char' ORDER BY side"
        ).fetchall() == [("content_clean", 25), ("content_original", 100)]
        assert connection.execute(
            "SELECT original,clean,delta,reduction_ratio "
            "FROM corpus_reduction_by_harness "
            "WHERE metrics_version='m1' AND harness='claude' AND dimension='char'"
        ).fetchone() == (100, 25, None, None)
        assert connection.execute(
            "SELECT original,clean,delta,reduction_ratio "
            "FROM corpus_reduction_by_project "
            "WHERE metrics_version='m1' AND project='project' AND dimension='char'"
        ).fetchone() == (100, 25, None, None)
    finally:
        connection.close()


def test_reduction_views_keep_mismatched_metrics_versions_separate(
    tmp_path: Path,
) -> None:
    connection = open_database(tmp_path / "qsesh.db")
    try:
        _seed_session(connection)
        connection.execute(
            "INSERT INTO session_size_metrics(qid,side,dimension,value,metrics_version,unicode_version) VALUES(?,?,?,?,?,'16.0.0')",
            ("qs-abcdefghij", "content_original", "char", 100, "m1"),
        )
        connection.execute(
            "INSERT INTO session_size_metrics(qid,side,dimension,value,metrics_version,unicode_version) VALUES(?,?,?,?,?,'16.0.0')",
            ("qs-abcdefghij", "content_clean", "char", 25, "m2"),
        )

        assert connection.execute(
            "SELECT metrics_version,original,clean,delta,reduction_ratio "
            "FROM session_content_reduction ORDER BY metrics_version"
        ).fetchall() == [
            ("m1", 100, None, None, None),
            ("m2", None, 25, None, None),
        ]
        assert connection.execute(
            "SELECT metrics_version,original,clean,delta,reduction_ratio "
            "FROM corpus_reduction_by_harness ORDER BY metrics_version"
        ).fetchall() == [
            ("m1", 100, None, None, None),
            ("m2", None, 25, None, None),
        ]
    finally:
        connection.close()


def test_content_reduction_views_exclude_raw_dimensions(tmp_path: Path) -> None:
    connection = open_database(tmp_path / "qsesh.db")
    try:
        _seed_session(connection)
        _seed_size_metrics(connection, "qs-abcdefghij", "m1", "bytes", 100, 25)

        assert (
            connection.execute(
                "SELECT * FROM session_content_reduction WHERE dimension='bytes'"
            ).fetchall()
            == []
        )
        assert (
            connection.execute(
                "SELECT * FROM corpus_reduction_by_harness WHERE dimension='bytes'"
            ).fetchall()
            == []
        )
        assert (
            connection.execute(
                "SELECT * FROM corpus_reduction_by_project WHERE dimension='bytes'"
            ).fetchall()
            == []
        )
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
        _seed_session(
            connection,
            qid="qs-abcdefghij",
            digest=b"d" * 32,
            native_id="n1",
            harness="claude",
            project="project-a",
        )
        _seed_session(
            connection,
            qid="qs-bbbbbbbbbb",
            digest=b"e" * 32,
            native_id="n2",
            harness="claude",
            project="project-b",
        )
        _seed_session(
            connection,
            qid="qs-cccccccccc",
            digest=b"f" * 32,
            native_id="n3",
            harness="codex",
            project="project-a",
        )
        _seed_size_metrics(connection, "qs-abcdefghij", "m1", "char", 100, 50)
        _seed_size_metrics(connection, "qs-bbbbbbbbbb", "m1", "char", 300, 100)
        _seed_size_metrics(connection, "qs-cccccccccc", "m1", "char", 40, 10)
        rows = connection.execute(
            "SELECT harness,original,clean,delta,reduction_ratio "
            "FROM corpus_reduction_by_harness "
            "WHERE metrics_version='m1' AND dimension='char' ORDER BY harness"
        ).fetchall()
        # aggregate-first: (100+300)-(50+100) over (100+300), NOT the average of
        # the two per-session ratios (0.5 and 0.667).
        assert rows == [
            ("claude", 400, 150, 250, 0.625),
            ("codex", 40, 10, 30, 0.75),
        ]
        assert all(isinstance(row[4], float) for row in rows)
    finally:
        connection.close()


def test_corpus_reduction_by_project_aggregates_before_dividing(
    tmp_path: Path,
) -> None:
    connection = open_database(tmp_path / "qsesh.db")
    try:
        _seed_session(
            connection,
            qid="qs-abcdefghij",
            digest=b"d" * 32,
            native_id="n1",
            harness="claude",
            project="project-a",
        )
        _seed_session(
            connection,
            qid="qs-bbbbbbbbbb",
            digest=b"e" * 32,
            native_id="n2",
            harness="claude",
            project="project-b",
        )
        _seed_session(
            connection,
            qid="qs-cccccccccc",
            digest=b"f" * 32,
            native_id="n3",
            harness="codex",
            project="project-a",
        )
        _seed_size_metrics(connection, "qs-abcdefghij", "m1", "char", 100, 50)
        _seed_size_metrics(connection, "qs-bbbbbbbbbb", "m1", "char", 300, 100)
        _seed_size_metrics(connection, "qs-cccccccccc", "m1", "char", 40, 10)
        rows = connection.execute(
            "SELECT project,original,clean,delta,reduction_ratio "
            "FROM corpus_reduction_by_project "
            "WHERE metrics_version='m1' AND dimension='char' ORDER BY project"
        ).fetchall()
        assert rows == [
            ("project-a", 140, 60, 80, pytest.approx(80 / 140)),
            ("project-b", 300, 100, 200, pytest.approx(2 / 3)),
        ]
        assert all(isinstance(row[4], float) for row in rows)
    finally:
        connection.close()


def test_session_size_metrics_rejects_invalid_dimension(tmp_path: Path) -> None:
    connection = open_database(tmp_path / "qsesh.db")
    try:
        _seed_session(connection)
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO session_size_metrics(qid,side,dimension,value,metrics_version,unicode_version) VALUES(?,?,?,?,?,'16.0.0')",
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
                "INSERT INTO session_size_metrics(qid,side,dimension,value,metrics_version,unicode_version) VALUES(?,?,?,?,?,'16.0.0')",
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
                "INSERT INTO session_size_metrics(qid,side,dimension,value,metrics_version,unicode_version) VALUES(?,?,?,?,?,'16.0.0')",
                ("qs-abcdefghij", "content_original", "char", 10, ""),
            )
    finally:
        connection.close()


def test_migration_rolls_back_completely_on_failure_after_ddl(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "data/qsesh.db"
    _build_raw_v1_database(path)
    original_checksum = schema_module.schema_checksum
    observed_versions: list[int] = []

    def fail_after_version_bump(connection: sqlite3.Connection) -> str:
        user_version = connection.execute("PRAGMA user_version").fetchone()[0]
        observed_versions.append(user_version)
        if user_version == 2:
            raise RuntimeError("injected failure after version bump, before commit")
        return original_checksum(connection)

    monkeypatch.setattr(schema_module, "schema_checksum", fail_after_version_bump)

    with pytest.raises(RuntimeError, match="after version bump"):
        open_database(path)
    assert 2 in observed_versions

    verify = sqlite3.connect(path)
    try:
        assert verify.execute("PRAGMA user_version").fetchone()[0] == 1
        assert original_checksum(verify) == V1_SCHEMA_ORACLE_SHA256
        assert "session_size_metrics" not in _objects(verify, "table")
        assert not EXPECTED_VIEWS & _objects(verify, "view")
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


def test_session_size_metrics_is_strict_rejecting_text_in_value(tmp_path) -> None:
    """value is INTEGER CHECK(value>=0); a non-STRICT table stores 'abc' as text
    and SUM() then returns 0.0, silently corrupting corpus totals. Every sibling
    table in this schema is STRICT; this one must be too."""
    connection = open_database(tmp_path / "qsesh.db")
    _seed_session(connection)
    with pytest.raises(sqlite3.IntegrityError):
        # Valid unicode_version supplied so this exercises the STRICT type check
        # on `value`, not the NOT NULL constraint on unicode_version.
        connection.execute(
            "INSERT INTO session_size_metrics"
            "(qid,side,dimension,value,metrics_version,unicode_version)"
            " VALUES(?,?,?,?,?,?)",
            (
                "qs-abcdefghij",
                "content_original",
                "char",
                "abc",
                "qsesh-metrics-v2",
                "16.0.0",
            ),
        )


def test_corpus_views_partition_by_unicode_version(tmp_path) -> None:
    """word/token counts resolve against the interpreter's Unicode database, so
    two sessions counted under different Unicode versions must NOT be summed into
    one corpus reduction ratio — that mixes values from two different counting
    algorithms under one metrics_version. The corpus views must group by
    unicode_version so each version aggregates separately."""
    connection = open_database(tmp_path / "qsesh.db")
    _seed_session(connection, qid="qs-aaaaaaaaaa", native_id="n-a", digest=b"a" * 32)
    _seed_session(connection, qid="qs-bbbbbbbbbb", native_id="n-b", digest=b"b" * 32)
    for qid, uv in (("qs-aaaaaaaaaa", "15.0.0"), ("qs-bbbbbbbbbb", "16.0.0")):
        connection.execute(
            "INSERT INTO session_size_metrics"
            "(qid,side,dimension,value,metrics_version,unicode_version)"
            " VALUES(?,?,?,?,?,?)",
            (qid, "content_original", "word", 100, "qsesh-metrics-v2", uv),
        )
        connection.execute(
            "INSERT INTO session_size_metrics"
            "(qid,side,dimension,value,metrics_version,unicode_version)"
            " VALUES(?,?,?,?,?,?)",
            (qid, "content_clean", "word", 40, "qsesh-metrics-v2", uv),
        )
    rows = connection.execute(
        "SELECT unicode_version, original FROM corpus_reduction_by_harness"
        " WHERE dimension='word' ORDER BY unicode_version"
    ).fetchall()
    # Two DISTINCT unicode versions -> two rows, NOT one merged 200-total row.
    assert rows == [("15.0.0", 100), ("16.0.0", 100)]
