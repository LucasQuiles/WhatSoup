import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetDbReader } from '../../src/fleet/db-reader.ts';

// The realtime poller asks every instance for its message/access markers every
// 2 s. MAX(updated_at) has no index, so each answer is a full scan of
// messages; doing that on a fresh connection per poll cost ~25k page reads/s
// in production. These tests pin the contract that replaces it: a change on the
// instance DB (insert, update, access decision, file replacement) is still
// detected, while an unchanged DB is answered without re-reading messages.

const SCHEMA = `
  CREATE TABLE messages (
    pk INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_key TEXT NOT NULL,
    content TEXT,
    timestamp INTEGER NOT NULL,
    updated_at TEXT
  );
  CREATE TABLE access_list (
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    status TEXT NOT NULL,
    requested_at TEXT,
    decided_at TEXT,
    PRIMARY KEY (subject_type, subject_id)
  );
`;

function createInstanceDb(path: string, journalMode = 'WAL'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = ${journalMode}`);
  db.exec(SCHEMA);
  db.prepare("INSERT INTO messages (conversation_key, content, timestamp, updated_at) VALUES ('c1', 'x', 1, '2026-01-01T00:00:00.000Z')").run();
  return db;
}

function markerReads(prepare: { mock: { calls: unknown[][] } }): number {
  return prepare.mock.calls.filter((call) => String(call[0]).includes('MAX(pk)')).length;
}

describe('FleetDbReader.getLatestMarkers change detection (remote instance)', () => {
  let dir: string;
  let dbPath: string;
  let writer: DatabaseSync;
  let selfDb: DatabaseSync;
  let reader: FleetDbReader;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-markers-'));
    dbPath = join(dir, 'bot.db');
    writer = createInstanceDb(dbPath);
    selfDb = new DatabaseSync(':memory:');
    reader = new FleetDbReader('fleet', selfDb);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    reader.close();
    writer.close();
    selfDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function markers() {
    const result = reader.getLatestMarkers('personal', dbPath);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }

  it('fires on a message insert from the instance process', () => {
    const before = markers();
    writer.prepare("INSERT INTO messages (conversation_key, content, timestamp, updated_at) VALUES ('c1', 'y', 2, '2026-01-01T00:00:01.000Z')").run();
    const after = markers();
    expect(after.latestMessagePk).toBe((before.latestMessagePk ?? 0) + 1);
    expect(after.latestMessageMarker).not.toBe(before.latestMessageMarker);
  });

  it('fires on a message update that keeps the latest pk', () => {
    const before = markers();
    writer.prepare("UPDATE messages SET content = 'edited', updated_at = '2026-01-01T00:00:05.000Z'").run();
    const after = markers();
    expect(after.latestMessagePk).toBe(before.latestMessagePk);
    expect(after.latestMessageMarker).toContain('2026-01-01T00:00:05.000Z');
    expect(after.latestMessageMarker).not.toBe(before.latestMessageMarker);
  });

  it('fires on an access-list decision', () => {
    const before = markers();
    writer.prepare("INSERT INTO access_list VALUES ('phone', '1', 'allowed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:09Z')").run();
    const after = markers();
    expect(before.latestAccessMarker).toBeNull();
    expect(after.latestAccessMarker).toBe('2026-01-01T00:00:09Z');
  });

  it('answers an unchanged database without re-reading messages', () => {
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
    const first = markers();
    expect(markers()).toEqual(first);
    expect(markers()).toEqual(first);
    expect(markerReads(prepare)).toBe(1);

    writer.prepare("UPDATE messages SET updated_at = '2026-01-01T00:00:07.000Z'").run();
    expect(markers().latestMessageMarker).toContain('2026-01-01T00:00:07.000Z');
    expect(markerReads(prepare)).toBe(2);
  });

  it('re-opens when the database file is replaced (restore or VACUUM INTO swap)', () => {
    // Rollback-journal mode: a WAL file cannot be tied to a replaced main
    // file, so a WAL-mode swap must also retire -wal/-shm; that is the
    // restore procedure's job, not the reader's.
    writer.close();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'fleet-markers-'));
    dbPath = join(dir, 'bot.db');
    writer = createInstanceDb(dbPath, 'DELETE');
    const before = markers();
    const replacementPath = join(dir, 'restored.db');
    const replacement = createInstanceDb(replacementPath, 'DELETE');
    replacement.prepare("INSERT INTO messages (conversation_key, content, timestamp, updated_at) VALUES ('c9', 'r', 9, '2026-02-02T00:00:00.000Z')").run();
    replacement.close();
    renameSync(replacementPath, dbPath);

    const after = markers();
    expect(after.latestMessageMarker).toContain('2026-02-02T00:00:00.000Z');
    expect(after.latestMessageMarker).not.toBe(before.latestMessageMarker);
  });

  it('reports a missing database as unavailable instead of serving a cached answer', () => {
    expect(reader.getLatestMarkers('personal', dbPath).ok).toBe(true);
    writer.close();
    rmSync(dir, { recursive: true, force: true });
    writer = new DatabaseSync(':memory:');
    expect(reader.getLatestMarkers('personal', dbPath).ok).toBe(false);
  });
});

describe('FleetDbReader.getLatestMarkers change detection (self instance)', () => {
  it('fires on writes made through the shared self handle', () => {
    const selfDb = new DatabaseSync(':memory:');
    selfDb.exec(SCHEMA);
    selfDb.prepare("INSERT INTO messages (conversation_key, content, timestamp, updated_at) VALUES ('c1', 'x', 1, '2026-01-01T00:00:00.000Z')").run();
    const reader = new FleetDbReader('self', selfDb);
    const read = () => {
      const result = reader.getLatestMarkers('self', '');
      if (!result.ok) throw new Error(result.error);
      return result.data;
    };

    const before = read();
    selfDb.prepare("UPDATE messages SET updated_at = '2026-01-01T00:00:03.000Z'").run();
    const updated = read();
    expect(updated.latestMessageMarker).not.toBe(before.latestMessageMarker);
    selfDb.prepare("INSERT INTO messages (conversation_key, content, timestamp, updated_at) VALUES ('c1', 'y', 2, '2026-01-01T00:00:04.000Z')").run();
    expect(read().latestMessagePk).toBe((updated.latestMessagePk ?? 0) + 1);

    reader.close();
    selfDb.close();
  });
});
