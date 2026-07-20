-- Frozen, populated qSesh schema-v1 fixture. Do not derive this from qsesh.schema.
CREATE TABLE archives(
    relpath TEXT PRIMARY KEY,
    harness TEXT NOT NULL CHECK(harness IN ('claude','codex','opencode')),
    qid TEXT NOT NULL CHECK(length(qid)=13 AND substr(qid,1,3)='qs-' AND substr(qid,4) NOT GLOB '*[^a-z2-7]*'),
    source_digest TEXT NOT NULL CHECK(length(source_digest)=64 AND source_digest NOT GLOB '*[^0-9a-f]*'),
    sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    byte_count INTEGER NOT NULL CHECK(byte_count>=0),
    accepted_at_us INTEGER NOT NULL CHECK(accepted_at_us>=0),
    UNIQUE(harness,qid,source_digest),
    UNIQUE(relpath,sha256,source_digest,byte_count),
    CHECK(relpath='archive/'||harness||'/'||qid||'/'||source_digest||'.jsonl.gz')
) STRICT;
CREATE TABLE sessions(
    qid TEXT PRIMARY KEY CHECK(length(qid)=13 AND substr(qid,1,3)='qs-' AND substr(qid,4) NOT GLOB '*[^a-z2-7]*'),
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
    source_digest TEXT NOT NULL CHECK(length(source_digest)=64 AND source_digest NOT GLOB '*[^0-9a-f]*'),
    archive_relpath TEXT NOT NULL,
    archive_sha256 TEXT NOT NULL CHECK(length(archive_sha256)=64 AND archive_sha256 NOT GLOB '*[^0-9a-f]*'),
    archive_byte_count INTEGER NOT NULL CHECK(archive_byte_count>=0),
    record_json TEXT NOT NULL CHECK(json_valid(record_json)),
    updated_at_us INTEGER NOT NULL CHECK(updated_at_us>=ended_at_us),
    UNIQUE(host_id,harness,native_id),
    FOREIGN KEY(archive_relpath,archive_sha256,source_digest,archive_byte_count)
      REFERENCES archives(relpath,sha256,source_digest,byte_count)
      DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX idx_sessions_started ON sessions(started_at_us DESC,qid ASC);
CREATE INDEX idx_sessions_project ON sessions(project,started_at_us DESC,qid ASC);
CREATE TABLE transcript_turns(
    qid TEXT NOT NULL REFERENCES sessions(qid) ON DELETE CASCADE,
    turn_index INTEGER NOT NULL CHECK(turn_index>=0),
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    timestamp_utc TEXT,
    text TEXT NOT NULL,
    PRIMARY KEY(qid,turn_index)
) STRICT;
CREATE TABLE transcript_documents(
    rowid INTEGER PRIMARY KEY,
    qid TEXT NOT NULL UNIQUE REFERENCES sessions(qid) ON DELETE CASCADE,
    text TEXT NOT NULL
) STRICT;
CREATE VIRTUAL TABLE transcripts USING fts5(qid UNINDEXED,text,content='transcript_documents',content_rowid='rowid',tokenize='unicode61');
CREATE TRIGGER transcript_documents_ai AFTER INSERT ON transcript_documents BEGIN
    INSERT INTO transcripts(rowid,qid,text) VALUES(new.rowid,new.qid,new.text);
END;
CREATE TRIGGER transcript_documents_ad AFTER DELETE ON transcript_documents BEGIN
    INSERT INTO transcripts(transcripts,rowid,qid,text) VALUES('delete',old.rowid,old.qid,old.text);
END;
CREATE TRIGGER transcript_documents_au AFTER UPDATE ON transcript_documents BEGIN
    INSERT INTO transcripts(transcripts,rowid,qid,text) VALUES('delete',old.rowid,old.qid,old.text);
    INSERT INTO transcripts(rowid,qid,text) VALUES(new.rowid,new.qid,new.text);
END;
CREATE TABLE session_tools(
    qid TEXT NOT NULL REFERENCES sessions(qid) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK(length(name)>0),
    is_mcp INTEGER NOT NULL CHECK(is_mcp IN (0,1)),
    count INTEGER NOT NULL CHECK(count>0),
    call_ids_json TEXT NOT NULL CHECK(json_valid(call_ids_json)),
    PRIMARY KEY(qid,name,is_mcp)
) STRICT;
CREATE TABLE session_skills(
    qid TEXT NOT NULL REFERENCES sessions(qid) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK(length(name)>0),
    count INTEGER NOT NULL CHECK(count>0),
    PRIMARY KEY(qid,name)
) STRICT;
CREATE TABLE session_files(
    qid TEXT NOT NULL REFERENCES sessions(qid) ON DELETE CASCADE,
    path TEXT NOT NULL CHECK(length(path)>0),
    count INTEGER NOT NULL CHECK(count>0),
    PRIMARY KEY(qid,path)
) STRICT;
CREATE TABLE session_subagents(
    qid TEXT NOT NULL REFERENCES sessions(qid) ON DELETE CASCADE,
    agent TEXT NOT NULL CHECK(length(agent)>0),
    count INTEGER NOT NULL CHECK(count>0),
    sidechain_count INTEGER NOT NULL CHECK(sidechain_count BETWEEN 0 AND count),
    PRIMARY KEY(qid,agent)
) STRICT;
CREATE TABLE session_compactions(
    qid TEXT NOT NULL REFERENCES sessions(qid) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK(ordinal>=0),
    count INTEGER NOT NULL CHECK(count>0),
    event_indices_json TEXT NOT NULL CHECK(json_valid(event_indices_json)),
    reasons_json TEXT NOT NULL CHECK(json_valid(reasons_json)),
    PRIMARY KEY(qid,ordinal)
) STRICT;
CREATE TABLE session_metrics(
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
) STRICT;
CREATE INDEX idx_session_metrics_grouping ON session_metrics(metric_kind,scope,source,unit,model);
CREATE TABLE cursors(
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
) STRICT;
CREATE TABLE ingest_runs(
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
) STRICT;
CREATE TABLE ingest_errors(
    error_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES ingest_runs(run_id) ON DELETE CASCADE,
    qid TEXT,
    source_key TEXT NOT NULL,
    code TEXT NOT NULL,
    phase TEXT NOT NULL,
    evidence_ref TEXT NOT NULL,
    created_at_us INTEGER NOT NULL CHECK(created_at_us>=0)
) STRICT;
CREATE INDEX idx_ingest_errors_run ON ingest_errors(run_id,created_at_us,error_id);
CREATE TABLE migrations(
    version INTEGER PRIMARY KEY CHECK(version>0),
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL CHECK(length(checksum)=64),
    applied_at_us INTEGER NOT NULL CHECK(applied_at_us>=0)
) STRICT;

PRAGMA application_id=1364411731;
PRAGMA user_version=1;

INSERT INTO archives(
    relpath,harness,qid,source_digest,sha256,byte_count,accepted_at_us
) VALUES(
    'archive/claude/qs-abcdefghij/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl.gz',
    'claude','qs-abcdefghij',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    10,1
);
INSERT INTO sessions(
    qid,identity_digest,host_id,harness,native_id,project,started_at_us,ended_at_us,
    duration_us,source_pointer,source_digest,archive_relpath,archive_sha256,
    archive_byte_count,record_json,updated_at_us
) VALUES(
    'qs-abcdefghij',
    X'6464646464646464646464646464646464646464646464646464646464646464',
    'fixture-host','claude','fixture-native','fixture-project',1,2,1,'fixture-source',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'archive/claude/qs-abcdefghij/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl.gz',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    10,'{"qid":"qs-abcdefghij"}',2
);
INSERT INTO transcript_turns(qid,turn_index,role,timestamp_utc,text)
VALUES('qs-abcdefghij',0,'user',NULL,'fixture turn');
INSERT INTO session_tools(qid,name,is_mcp,count,call_ids_json)
VALUES('qs-abcdefghij','fixture_tool',0,2,'["call-1","call-2"]');
