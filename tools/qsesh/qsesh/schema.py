"""Schema-v2 DDL, checksum, migration, and fail-closed SQLite connection invariants."""

from __future__ import annotations

import hashlib
import os
import sqlite3
import stat
import time
from pathlib import Path

from .errors import QseshError
from .paths import ensure_private_dir

APPLICATION_ID = 0x51534553
CURRENT_SCHEMA_VERSION = 2
BUSY_TIMEOUT_MS = 5_000
V1_SCHEMA_SHA256 = "0bdb585c87f3020325985ac99a89101fc68aeb048a7af8607692346e5d6ee48c"
SCHEMA_SHA256 = "7af29e7d72c072d1eb7078af0d9bd89f63225dadd0e28d516f1fbe924392df66"
_MIGRATION_2_NAME = "0002-session-size-metrics"

_QID_CHECK = (
    "length(qid)=13 AND substr(qid,1,3)='qs-' AND substr(qid,4) NOT GLOB '*[^a-z2-7]*'"
)
_HEX64 = "length({field})=64 AND {field} NOT GLOB '*[^0-9a-f]*'"

_V1_DDL = (
    f"""CREATE TABLE archives(
        relpath TEXT PRIMARY KEY,
        harness TEXT NOT NULL CHECK(harness IN ('claude','codex','opencode')),
        qid TEXT NOT NULL CHECK({_QID_CHECK}),
        source_digest TEXT NOT NULL CHECK({_HEX64.format(field="source_digest")}),
        sha256 TEXT NOT NULL CHECK({_HEX64.format(field="sha256")}),
        byte_count INTEGER NOT NULL CHECK(byte_count>=0),
        accepted_at_us INTEGER NOT NULL CHECK(accepted_at_us>=0),
        UNIQUE(harness,qid,source_digest),
        UNIQUE(relpath,sha256,source_digest,byte_count),
        CHECK(relpath='archive/'||harness||'/'||qid||'/'||source_digest||'.jsonl.gz')
    ) STRICT""",
    f"""CREATE TABLE sessions(
        qid TEXT PRIMARY KEY CHECK({_QID_CHECK}),
        identity_digest BLOB NOT NULL UNIQUE CHECK(length(identity_digest)=32),
        host_id TEXT NOT NULL CHECK(length(host_id)>0),
        harness TEXT NOT NULL CHECK(harness IN ('claude','codex','opencode')),
        native_id TEXT NOT NULL CHECK(length(native_id)>0),
        project TEXT NOT NULL CHECK(length(project)>0),
        git_branch TEXT,
        title TEXT,
        started_at_us INTEGER NOT NULL CHECK(started_at_us>=0),
        ended_at_us INTEGER NOT NULL CHECK(ended_at_us>=started_at_us),
        duration_us INTEGER NOT NULL CHECK(duration_us=ended_at_us-started_at_us),
        harness_version TEXT,
        source_pointer TEXT NOT NULL CHECK(length(source_pointer)>0),
        source_digest TEXT NOT NULL CHECK({_HEX64.format(field="source_digest")}),
        archive_relpath TEXT NOT NULL,
        archive_sha256 TEXT NOT NULL CHECK({_HEX64.format(field="archive_sha256")}),
        archive_byte_count INTEGER NOT NULL CHECK(archive_byte_count>=0),
        record_json TEXT NOT NULL CHECK(json_valid(record_json)),
        updated_at_us INTEGER NOT NULL CHECK(updated_at_us>=ended_at_us),
        UNIQUE(host_id,harness,native_id),
        FOREIGN KEY(archive_relpath,archive_sha256,source_digest,archive_byte_count)
          REFERENCES archives(relpath,sha256,source_digest,byte_count)
          DEFERRABLE INITIALLY DEFERRED
    ) STRICT""",
    "CREATE INDEX idx_sessions_started ON sessions(started_at_us DESC,qid ASC)",
    "CREATE INDEX idx_sessions_project ON sessions(project,started_at_us DESC,qid ASC)",
    """CREATE TABLE transcript_turns(
        qid TEXT NOT NULL REFERENCES sessions(qid) ON DELETE CASCADE,
        turn_index INTEGER NOT NULL CHECK(turn_index>=0),
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        timestamp_utc TEXT,
        text TEXT NOT NULL,
        PRIMARY KEY(qid,turn_index)
    ) STRICT""",
    """CREATE TABLE transcript_documents(
        rowid INTEGER PRIMARY KEY,
        qid TEXT NOT NULL UNIQUE REFERENCES sessions(qid) ON DELETE CASCADE,
        text TEXT NOT NULL
    ) STRICT""",
    "CREATE VIRTUAL TABLE transcripts USING fts5(qid UNINDEXED,text,content='transcript_documents',content_rowid='rowid',tokenize='unicode61')",
    """CREATE TRIGGER transcript_documents_ai AFTER INSERT ON transcript_documents BEGIN
        INSERT INTO transcripts(rowid,qid,text) VALUES(new.rowid,new.qid,new.text);
    END""",
    """CREATE TRIGGER transcript_documents_ad AFTER DELETE ON transcript_documents BEGIN
        INSERT INTO transcripts(transcripts,rowid,qid,text) VALUES('delete',old.rowid,old.qid,old.text);
    END""",
    """CREATE TRIGGER transcript_documents_au AFTER UPDATE ON transcript_documents BEGIN
        INSERT INTO transcripts(transcripts,rowid,qid,text) VALUES('delete',old.rowid,old.qid,old.text);
        INSERT INTO transcripts(rowid,qid,text) VALUES(new.rowid,new.qid,new.text);
    END""",
    """CREATE TABLE session_tools(
        qid TEXT NOT NULL REFERENCES sessions(qid) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK(length(name)>0),
        is_mcp INTEGER NOT NULL CHECK(is_mcp IN (0,1)),
        count INTEGER NOT NULL CHECK(count>0),
        call_ids_json TEXT NOT NULL CHECK(json_valid(call_ids_json)),
        PRIMARY KEY(qid,name,is_mcp)
    ) STRICT""",
    """CREATE TABLE session_skills(
        qid TEXT NOT NULL REFERENCES sessions(qid) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK(length(name)>0),
        count INTEGER NOT NULL CHECK(count>0),
        PRIMARY KEY(qid,name)
    ) STRICT""",
    """CREATE TABLE session_files(
        qid TEXT NOT NULL REFERENCES sessions(qid) ON DELETE CASCADE,
        path TEXT NOT NULL CHECK(length(path)>0),
        count INTEGER NOT NULL CHECK(count>0),
        PRIMARY KEY(qid,path)
    ) STRICT""",
    """CREATE TABLE session_subagents(
        qid TEXT NOT NULL REFERENCES sessions(qid) ON DELETE CASCADE,
        agent TEXT NOT NULL CHECK(length(agent)>0),
        count INTEGER NOT NULL CHECK(count>0),
        sidechain_count INTEGER NOT NULL CHECK(sidechain_count BETWEEN 0 AND count),
        PRIMARY KEY(qid,agent)
    ) STRICT""",
    """CREATE TABLE session_compactions(
        qid TEXT NOT NULL REFERENCES sessions(qid) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal>=0),
        count INTEGER NOT NULL CHECK(count>0),
        event_indices_json TEXT NOT NULL CHECK(json_valid(event_indices_json)),
        reasons_json TEXT NOT NULL CHECK(json_valid(reasons_json)),
        PRIMARY KEY(qid,ordinal)
    ) STRICT""",
    """CREATE TABLE session_metrics(
        qid TEXT NOT NULL REFERENCES sessions(qid) ON DELETE CASCADE,
        metric_kind TEXT NOT NULL CHECK(metric_kind IN ('usage','cost')),
        metric_index INTEGER NOT NULL CHECK(metric_index>=0),
        scope TEXT NOT NULL CHECK(scope IN ('session','message')),
        source TEXT NOT NULL CHECK(length(source)>0),
        unit TEXT NOT NULL CHECK(length(unit)>0),
        model TEXT,
        provider TEXT,
        values_json TEXT CHECK(values_json IS NULL OR json_valid(values_json)),
        value_numeric REAL,
        CHECK((metric_kind='usage' AND values_json IS NOT NULL AND value_numeric IS NULL) OR
              (metric_kind='cost' AND values_json IS NULL AND value_numeric IS NOT NULL AND value_numeric>=0)),
        PRIMARY KEY(qid,metric_kind,metric_index)
    ) STRICT""",
    "CREATE INDEX idx_session_metrics_grouping ON session_metrics(metric_kind,scope,source,unit,model)",
    """CREATE TABLE cursors(
        host_id TEXT NOT NULL,
        harness TEXT NOT NULL CHECK(harness IN ('claude','codex','opencode')),
        native_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        updated_at_us INTEGER NOT NULL CHECK(updated_at_us>=0),
        device INTEGER,
        inode INTEGER,
        size INTEGER,
        mtime_ns INTEGER,
        ctime_ns INTEGER,
        source_digest TEXT NOT NULL CHECK(length(source_digest)=64),
        extractor_contract TEXT NOT NULL,
        PRIMARY KEY(host_id,harness,native_id)
    ) STRICT""",
    """CREATE TABLE ingest_runs(
        run_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK(mode IN ('incremental','full','redistill')),
        status TEXT NOT NULL CHECK(status IN ('running','complete','complete_with_quarantine','failed')),
        started_at_us INTEGER NOT NULL CHECK(started_at_us>=0),
        ended_at_us INTEGER,
        discovered INTEGER NOT NULL DEFAULT 0 CHECK(discovered>=0),
        new_count INTEGER NOT NULL DEFAULT 0 CHECK(new_count>=0),
        updated_count INTEGER NOT NULL DEFAULT 0 CHECK(updated_count>=0),
        unchanged INTEGER NOT NULL DEFAULT 0 CHECK(unchanged>=0),
        skipped_live INTEGER NOT NULL DEFAULT 0 CHECK(skipped_live>=0),
        source_raced INTEGER NOT NULL DEFAULT 0 CHECK(source_raced>=0),
        quarantined INTEGER NOT NULL DEFAULT 0 CHECK(quarantined>=0),
        fatal_unprocessed INTEGER NOT NULL DEFAULT 0 CHECK(fatal_unprocessed>=0),
        error_code TEXT
    ) STRICT""",
    """CREATE TABLE ingest_errors(
        error_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES ingest_runs(run_id) ON DELETE CASCADE,
        qid TEXT,
        source_key TEXT NOT NULL,
        code TEXT NOT NULL,
        phase TEXT NOT NULL,
        evidence_ref TEXT NOT NULL,
        created_at_us INTEGER NOT NULL CHECK(created_at_us>=0)
    ) STRICT""",
    "CREATE INDEX idx_ingest_errors_run ON ingest_errors(run_id,created_at_us,error_id)",
    """CREATE TABLE migrations(
        version INTEGER PRIMARY KEY CHECK(version>0),
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL CHECK(length(checksum)=64),
        applied_at_us INTEGER NOT NULL CHECK(applied_at_us>=0)
    ) STRICT""",
)

_V2_ADDITIONS = (
    """CREATE TABLE session_size_metrics(
        qid TEXT NOT NULL REFERENCES sessions(qid) ON DELETE CASCADE,
        side TEXT NOT NULL,
        dimension TEXT NOT NULL CHECK(dimension IN ('char','line','word','token','bytes','gzip_bytes')),
        value INTEGER NOT NULL CHECK(value>=0),
        metrics_version TEXT NOT NULL CHECK(length(metrics_version)>0),
        unicode_version TEXT NOT NULL CHECK(length(unicode_version)>0),
        PRIMARY KEY(qid,side,dimension)
    ) STRICT""",
    # unicode_version is carried through every aggregation. word/token counts
    # resolve against the interpreter's Unicode database, so summing values from
    # two Unicode versions under one metrics_version would average two different
    # algorithms. It is a per-session attribute (one interpreter per distill) so
    # it does not multiply per-session rows, but the corpus views MUST group by it
    # or the mixing is silent.
    """CREATE VIEW session_content_reduction AS
    WITH metric_keys AS (
        SELECT qid, metrics_version, unicode_version, dimension
        FROM session_size_metrics
        WHERE side IN ('content_original','content_clean')
          AND dimension IN ('char','line','word','token')
        GROUP BY qid, metrics_version, unicode_version, dimension
    )
    SELECT k.qid AS qid, k.metrics_version AS metrics_version,
           k.unicode_version AS unicode_version, k.dimension AS dimension,
           o.value AS original, c.value AS clean,
           CASE WHEN o.value IS NULL OR c.value IS NULL THEN NULL ELSE o.value-c.value END AS delta,
           CASE WHEN o.value IS NULL OR c.value IS NULL OR o.value=0 THEN NULL
                ELSE CAST(o.value-c.value AS REAL)/o.value END AS reduction_ratio
    FROM metric_keys k
    LEFT JOIN session_size_metrics o
      ON o.qid=k.qid AND o.metrics_version=k.metrics_version
     AND o.unicode_version=k.unicode_version AND o.dimension=k.dimension
     AND o.side='content_original'
    LEFT JOIN session_size_metrics c
      ON c.qid=k.qid AND c.metrics_version=k.metrics_version
     AND c.unicode_version=k.unicode_version AND c.dimension=k.dimension
     AND c.side='content_clean'""",
    """CREATE VIEW corpus_size_totals AS
    SELECT metrics_version, unicode_version, dimension, side, SUM(value) AS total
    FROM session_size_metrics GROUP BY metrics_version, unicode_version, dimension, side""",
    """CREATE VIEW corpus_reduction_by_harness AS
    SELECT r.metrics_version AS metrics_version, r.unicode_version AS unicode_version,
           s.harness AS harness, r.dimension AS dimension,
           SUM(r.original) AS original, SUM(r.clean) AS clean,
           CASE WHEN COUNT(r.original)=COUNT(*) AND COUNT(r.clean)=COUNT(*)
                THEN SUM(r.original)-SUM(r.clean) ELSE NULL END AS delta,
           CASE WHEN COUNT(r.original)!=COUNT(*) OR COUNT(r.clean)!=COUNT(*) OR SUM(r.original)=0
                THEN NULL ELSE CAST(SUM(r.original)-SUM(r.clean) AS REAL)/SUM(r.original) END AS reduction_ratio
    FROM session_content_reduction r JOIN sessions s ON s.qid=r.qid
    GROUP BY r.metrics_version, r.unicode_version, s.harness, r.dimension""",
    """CREATE VIEW corpus_reduction_by_project AS
    SELECT r.metrics_version AS metrics_version, r.unicode_version AS unicode_version,
           s.project AS project, r.dimension AS dimension,
           SUM(r.original) AS original, SUM(r.clean) AS clean,
           CASE WHEN COUNT(r.original)=COUNT(*) AND COUNT(r.clean)=COUNT(*)
                THEN SUM(r.original)-SUM(r.clean) ELSE NULL END AS delta,
           CASE WHEN COUNT(r.original)!=COUNT(*) OR COUNT(r.clean)!=COUNT(*) OR SUM(r.original)=0
                THEN NULL ELSE CAST(SUM(r.original)-SUM(r.clean) AS REAL)/SUM(r.original) END AS reduction_ratio
    FROM session_content_reduction r JOIN sessions s ON s.qid=r.qid
    GROUP BY r.metrics_version, r.unicode_version, s.project, r.dimension""",
)

DDL = _V1_DDL + _V2_ADDITIONS


def _fail(phase: str, error: BaseException | None = None) -> QseshError:
    failure = QseshError("QS-E-MIGRATION", phase=phase)
    if error is not None:
        failure.__cause__ = error
    return failure


def normalized_schema(connection: sqlite3.Connection) -> str:
    rows = connection.execute(
        "SELECT type,name,sql FROM sqlite_master "
        "WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' "
        "AND name NOT GLOB 'transcripts_*' ORDER BY type,name"
    ).fetchall()
    return "\n".join(
        f"{kind}:{name}:{' '.join(sql.split())}" for kind, name, sql in rows
    )


def schema_checksum(connection: sqlite3.Connection) -> str:
    return hashlib.sha256(normalized_schema(connection).encode()).hexdigest()


def _ensure_wal_mode(connection: sqlite3.Connection) -> None:
    deadline = time.monotonic() + (BUSY_TIMEOUT_MS / 1_000)
    last_error: sqlite3.DatabaseError | None = None
    while True:
        try:
            mode = connection.execute("PRAGMA journal_mode").fetchone()[0].lower()
            if mode == "wal":
                return
            mode = connection.execute("PRAGMA journal_mode=WAL").fetchone()[0].lower()
            if mode == "wal":
                return
        except sqlite3.DatabaseError as error:
            last_error = error
        if time.monotonic() >= deadline:
            raise _fail("schema-pragma-journal-mode", last_error) from last_error
        time.sleep(0.01)


def _configure(connection: sqlite3.Connection) -> None:
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
    _ensure_wal_mode(connection)
    connection.execute("PRAGMA synchronous=FULL")
    try:
        connection.execute("PRAGMA trusted_schema=OFF")
    except sqlite3.DatabaseError as error:
        raise _fail("schema-trusted-schema", error) from error
    expected = {
        "foreign_keys": 1,
        "synchronous": 2,
        "busy_timeout": BUSY_TIMEOUT_MS,
        "trusted_schema": 0,
    }
    for name, value in expected.items():
        if connection.execute(f"PRAGMA {name}").fetchone()[0] != value:
            raise _fail(f"schema-pragma-{name}")
    if connection.execute("PRAGMA journal_mode").fetchone()[0].lower() != "wal":
        raise _fail("schema-pragma-journal-mode")


def _inspect_existing(connection: sqlite3.Connection) -> tuple[int, int, bool]:
    application_id = connection.execute("PRAGMA application_id").fetchone()[0]
    user_version = connection.execute("PRAGMA user_version").fetchone()[0]
    has_objects = (
        connection.execute(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%')"
        ).fetchone()[0]
        == 1
    )
    return application_id, user_version, has_objects


def _validate_observed_schema(
    connection: sqlite3.Connection, *, allow_state_retry: bool = True
) -> tuple[int, int, bool]:
    application_id, user_version, has_objects = _inspect_existing(connection)
    if application_id not in {0, APPLICATION_ID} or (
        application_id == 0 and has_objects
    ):
        raise _fail("schema-application-id")
    if user_version > CURRENT_SCHEMA_VERSION:
        raise _fail("schema-newer-version")
    if application_id == APPLICATION_ID:
        if user_version == CURRENT_SCHEMA_VERSION:
            expected_checksum = SCHEMA_SHA256
        elif user_version == 1:
            expected_checksum = V1_SCHEMA_SHA256
        else:
            raise _fail("schema-drift")
        if schema_checksum(connection) != expected_checksum:
            if allow_state_retry:
                refreshed = _inspect_existing(connection)
                if refreshed != (application_id, user_version, has_objects):
                    return _validate_observed_schema(
                        connection, allow_state_retry=False
                    )
            raise _fail("schema-drift")
    if application_id == 0 and user_version != 0:
        raise _fail("schema-application-id")
    return application_id, user_version, has_objects


def _wal_fingerprint(target: Path) -> tuple[int, int, int, int, int, int] | None:
    try:
        wal_stat = Path(f"{target}-wal").lstat()
    except FileNotFoundError:
        return None
    return (
        stat.S_IFMT(wal_stat.st_mode),
        wal_stat.st_dev,
        wal_stat.st_ino,
        wal_stat.st_size,
        wal_stat.st_mtime_ns,
        wal_stat.st_ctime_ns,
    )


def _reject_mode_read_only_database(target: Path) -> None:
    before_wal = _wal_fingerprint(target)
    if before_wal is not None and (before_wal[0] != stat.S_IFREG or before_wal[3] > 0):
        raise _fail("schema-read-only-wal")
    try:
        connection = sqlite3.connect(
            f"{target.as_uri()}?mode=ro&immutable=1",
            uri=True,
            timeout=BUSY_TIMEOUT_MS / 1_000,
            isolation_level=None,
        )
    except sqlite3.DatabaseError as error:
        raise _fail("schema-read-only", error) from error
    try:
        application_id, user_version, _ = _validate_observed_schema(connection)
        phase = (
            "migration-read-only"
            if application_id == APPLICATION_ID and user_version == 1
            else "schema-read-only"
        )
    finally:
        connection.close()
    if _wal_fingerprint(target) != before_wal:
        raise _fail("schema-read-only-wal")
    raise _fail(phase)


def _harden_database_files(target: Path) -> None:
    for candidate in (target, Path(f"{target}-wal"), Path(f"{target}-shm")):
        try:
            candidate_stat = candidate.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISREG(candidate_stat.st_mode):
            os.chmod(candidate, 0o600, follow_symlinks=False)


def _record_v2_migration(connection: sqlite3.Connection) -> None:
    connection.execute(
        "INSERT INTO migrations(version,name,checksum,applied_at_us) VALUES(?,?,?,?)",
        (
            CURRENT_SCHEMA_VERSION,
            _MIGRATION_2_NAME,
            SCHEMA_SHA256,
            time.time_ns() // 1_000,
        ),
    )


def _verify_transition_result(connection: sqlite3.Connection, phase: str) -> None:
    if connection.execute("PRAGMA foreign_key_check").fetchall():
        raise _fail(f"{phase}-foreign-key-check")
    if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise _fail(f"{phase}-quick-check")
    if schema_checksum(connection) != SCHEMA_SHA256:
        raise _fail(f"{phase}-checksum")


def _apply_schema_transition(
    connection: sqlite3.Connection, *, initial_version: int
) -> None:
    failure_phase = (
        "schema-transaction" if initial_version == 0 else "migration-transaction"
    )
    try:
        connection.execute("BEGIN IMMEDIATE")
        application_id, user_version, has_objects = _inspect_existing(connection)

        if application_id == APPLICATION_ID and user_version == CURRENT_SCHEMA_VERSION:
            if schema_checksum(connection) != SCHEMA_SHA256:
                raise _fail("schema-drift")
            connection.commit()
            return

        if initial_version == 0:
            if application_id != 0 or user_version != 0 or has_objects:
                raise _fail("schema-drift")
            for statement in DDL:
                connection.execute(statement)
            connection.execute(f"PRAGMA application_id={APPLICATION_ID}")
            _record_v2_migration(connection)
            connection.execute(f"PRAGMA user_version={CURRENT_SCHEMA_VERSION}")
            validation_phase = "schema"
        else:
            if application_id != APPLICATION_ID or user_version != 1:
                raise _fail("schema-drift")
            if schema_checksum(connection) != V1_SCHEMA_SHA256:
                raise _fail("schema-drift")
            for statement in _V2_ADDITIONS:
                connection.execute(statement)
            _record_v2_migration(connection)
            connection.execute(f"PRAGMA user_version={CURRENT_SCHEMA_VERSION}")
            validation_phase = "migration"

        _verify_transition_result(connection, validation_phase)
        connection.commit()
    except QseshError:
        connection.rollback()
        raise
    except sqlite3.DatabaseError as error:
        connection.rollback()
        raise _fail(failure_phase, error) from error
    except BaseException:
        connection.rollback()
        raise


def open_database(path: Path) -> sqlite3.Connection:
    target = Path(path)
    if not target.is_absolute() or ".." in target.parts:
        raise _fail("schema-path")
    ensure_private_dir(target.parent)
    try:
        existing_stat = target.lstat()
    except FileNotFoundError:
        pass
    else:
        if stat.S_ISLNK(existing_stat.st_mode) or not stat.S_ISREG(
            existing_stat.st_mode
        ):
            raise _fail("schema-path")
        if existing_stat.st_mode & 0o222 == 0:
            _reject_mode_read_only_database(target)

    connection = sqlite3.connect(
        target, timeout=BUSY_TIMEOUT_MS / 1_000, isolation_level=None
    )
    try:
        application_id, user_version, _ = _validate_observed_schema(connection)

        _configure(connection)
        if application_id == 0:
            _apply_schema_transition(connection, initial_version=0)
        elif application_id == APPLICATION_ID and user_version == 1:
            _apply_schema_transition(connection, initial_version=1)
        _harden_database_files(target)
        return connection
    except BaseException as error:
        connection.close()
        try:
            _harden_database_files(target)
        except OSError:
            error.add_note("database permission hardening failed")
        raise
