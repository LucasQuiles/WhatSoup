import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync, writeFileSync } from 'node:fs';
import { FleetDbReader } from '../../src/fleet/db-reader.ts';
import type { MessageRow, AccessEntry } from '../../src/fleet/db-reader.ts';
import { buildSafeFtsMatchQuery } from '../../src/lib/sql-fts.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

function tmpFile(): string {
  return join(tmpdir(), `fleet-dbr-test-${randomBytes(8).toString('hex')}.db`);
}

function cleanup(...paths: string[]): void {
  for (const p of paths) {
    for (const suffix of ['', '-wal', '-shm']) {
      const full = p + suffix;
      if (existsSync(full)) {
        try { unlinkSync(full); } catch { /* ignore */ }
      }
    }
  }
}

/** Minimal schema — just the tables FleetDbReader touches. */
const MINIMAL_SCHEMA = `
  CREATE TABLE messages (
    pk INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_jid TEXT NOT NULL,
    conversation_key TEXT NOT NULL,
    sender_jid TEXT NOT NULL,
    sender_name TEXT,
    message_id TEXT UNIQUE,
    content TEXT,
    content_type TEXT NOT NULL DEFAULT 'text',
    is_from_me INTEGER NOT NULL DEFAULT 0,
    timestamp INTEGER NOT NULL,
    quoted_message_id TEXT,
    edited_at TEXT,
    deleted_at TEXT,
    raw_message TEXT,
    updated_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE access_list (
    subject_type TEXT NOT NULL CHECK (subject_type IN ('phone', 'group')),
    subject_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('allowed', 'blocked', 'pending', 'seen')),
    display_name TEXT,
    requested_at TEXT,
    decided_at TEXT,
    PRIMARY KEY (subject_type, subject_id)
  );

  CREATE VIRTUAL TABLE messages_fts USING fts5(content, content=messages, content_rowid=pk);
`;

/** Seed a DB with test messages and access_list entries. */
function seedDb(db: DatabaseSync): void {
  db.exec(MINIMAL_SCHEMA);

  const insertMsg = db.prepare(`
    INSERT INTO messages (chat_jid, conversation_key, sender_jid, sender_name,
                          content, content_type, is_from_me, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // DM conversation — 3 messages
  insertMsg.run('5551234@s.whatsapp.net', '5551234', '5551234@s.whatsapp.net', 'Alice', 'hello', 'text', 0, 1000);
  insertMsg.run('5551234@s.whatsapp.net', '5551234', '5551234@s.whatsapp.net', 'Alice', 'how are you?', 'text', 0, 1001);
  insertMsg.run('5551234@s.whatsapp.net', '5551234', 'me@s.whatsapp.net', null, 'good!', 'text', 1, 1002);

  // Group conversation — 2 messages
  insertMsg.run('group1@g.us', 'group1@g.us', '5559999@s.whatsapp.net', 'Bob', 'meeting?', 'text', 0, 2000);
  insertMsg.run('group1@g.us', 'group1@g.us', 'me@s.whatsapp.net', null, 'sure', 'text', 1, 2001);

  // Soft-deleted message (should be excluded)
  db.prepare(`
    INSERT INTO messages (chat_jid, conversation_key, sender_jid, sender_name,
                          content, content_type, is_from_me, timestamp, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run('5551234@s.whatsapp.net', '5551234', '5551234@s.whatsapp.net', 'Alice', 'deleted msg', 'text', 0, 999);

  // Access list entries
  const insertAccess = db.prepare(`
    INSERT INTO access_list (subject_type, subject_id, status, display_name, requested_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertAccess.run('phone', '5551234', 'allowed', 'Alice', '2025-01-01T00:00:00');
  insertAccess.run('phone', '5559999', 'pending', 'Bob', '2025-01-02T00:00:00');
  insertAccess.run('group', 'group1@g.us', 'allowed', 'Work Group', '2025-01-03T00:00:00');
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('FleetDbReader', () => {
  let selfDb: DatabaseSync;
  let reader: FleetDbReader;

  beforeEach(() => {
    selfDb = new DatabaseSync(':memory:');
    seedDb(selfDb);
    reader = new FleetDbReader('self', selfDb);
  });

  afterEach(() => {
    try { selfDb.close(); } catch { /* ok */ }
  });

  // ── getChats ────────────────────────────────────────────────────────────

  describe('getChats', () => {
    it('returns chat summaries grouped by conversation_key', () => {
      const result = reader.getChats('self', '', { limit: 50, offset: 0 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data).toHaveLength(2);

      // Group chat has higher timestamp (2001) so it comes first
      const group = result.data[0];
      expect(group.conversationKey).toBe('group1@g.us');
      expect(group.messageCount).toBe(2);
      expect(group.isGroup).toBe(true);
      expect(group.lastMessageAt).toBe(2001);

      const dm = result.data[1];
      expect(dm.conversationKey).toBe('5551234');
      expect(dm.messageCount).toBe(3);
      expect(dm.isGroup).toBe(false);
      expect(dm.lastMessageAt).toBe(1002);
    });

    it('respects limit and offset for pagination', () => {
      const page1 = reader.getChats('self', '', { limit: 1, offset: 0 });
      expect(page1.ok).toBe(true);
      if (!page1.ok) return;
      expect(page1.data).toHaveLength(1);
      expect(page1.data[0].conversationKey).toBe('group1@g.us');

      const page2 = reader.getChats('self', '', { limit: 1, offset: 1 });
      expect(page2.ok).toBe(true);
      if (!page2.ok) return;
      expect(page2.data).toHaveLength(1);
      expect(page2.data[0].conversationKey).toBe('5551234');
    });

    it('excludes soft-deleted messages from counts', () => {
      const result = reader.getChats('self', '', { limit: 50, offset: 0 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const dm = result.data.find((c) => c.conversationKey === '5551234');
      // 3 non-deleted messages (the deleted one at ts=999 is excluded)
      expect(dm?.messageCount).toBe(3);
    });
  });

  // ── getMessages ─────────────────────────────────────────────────────────

  describe('getMessages', () => {
    it('returns messages for a conversation ordered by pk DESC', () => {
      const result = reader.getMessages('self', '', {
        conversationKey: '5551234',
        limit: 50,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data).toHaveLength(3);
      // Descending pk order
      expect(result.data[0].content).toBe('good!');
      expect(result.data[0].is_from_me).toBe(1);
      expect(result.data[1].content).toBe('how are you?');
      expect(result.data[2].content).toBe('hello');
    });

    it('supports cursor pagination via beforePk', () => {
      // Get all first to find a pk
      const all = reader.getMessages('self', '', { conversationKey: '5551234', limit: 50 });
      expect(all.ok).toBe(true);
      if (!all.ok) return;

      const middlePk = all.data[0].pk; // highest pk
      const result = reader.getMessages('self', '', {
        conversationKey: '5551234',
        beforePk: middlePk,
        limit: 50,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toHaveLength(2);
      expect(result.data.every((m) => m.pk < middlePk)).toBe(true);
    });

    it('excludes soft-deleted messages', () => {
      const result = reader.getMessages('self', '', { conversationKey: '5551234', limit: 50 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.some((m) => m.content === 'deleted msg')).toBe(false);
    });

    it('respects limit', () => {
      const result = reader.getMessages('self', '', { conversationKey: '5551234', limit: 1 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toHaveLength(1);
    });
  });

  // ── getAccessList ───────────────────────────────────────────────────────

  describe('getAccessList', () => {
    it('returns all access_list entries ordered by requested_at DESC', () => {
      const result = reader.getAccessList('self', '');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data).toHaveLength(3);
      // Ordered by requested_at DESC
      expect(result.data[0].subjectId).toBe('group1@g.us');
      expect(result.data[0].subjectType).toBe('group');
      expect(result.data[1].subjectId).toBe('5559999');
      expect(result.data[1].status).toBe('pending');
      expect(result.data[2].displayName).toBe('Alice');
    });
  });

  // ── getSummaryStats ─────────────────────────────────────────────────────

  describe('getSummaryStats', () => {
    it('returns correct message and chat counts', () => {
      const result = reader.getSummaryStats('self', '');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.messageCount).toBe(5); // 3 DM + 2 group (deleted excluded)
      expect(result.data.chatCount).toBe(2);
      expect(result.data.pendingAccess).toBe(1); // Bob
    });

    it('handles missing access_list table gracefully', () => {
      const noAccessDb = new DatabaseSync(':memory:');
      noAccessDb.exec(`
        CREATE TABLE messages (
          pk INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_key TEXT NOT NULL,
          deleted_at TEXT,
          timestamp INTEGER NOT NULL
        );
      `);
      const noAccessReader = new FleetDbReader('noAccess', noAccessDb);
      const result = noAccessReader.getSummaryStats('noAccess', '');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.pendingAccess).toBe(0);
      noAccessDb.close();
    });
  });

  // ── self-instance routing ───────────────────────────────────────────────

  describe('self-instance routing', () => {
    it('uses selfDb directly for self-instance (dbPath ignored)', () => {
      // Pass a bogus dbPath — should still work since it uses selfDb
      const result = reader.getChats('self', '/nonexistent/path.db', { limit: 10, offset: 0 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.length).toBeGreaterThan(0);
    });
  });

  // ── remote DB via file ──────────────────────────────────────────────────

  describe('remote DB (file-based)', () => {
    let remotePath: string;

    beforeEach(() => {
      remotePath = tmpFile();
      const remoteDb = new DatabaseSync(remotePath);
      seedDb(remoteDb);
      remoteDb.close();
    });

    afterEach(() => {
      cleanup(remotePath);
    });

    it('opens a remote DB readonly, queries, and closes', () => {
      const result = reader.getSummaryStats('remote-instance', remotePath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.messageCount).toBe(5);
      expect(result.data.chatCount).toBe(2);
    });

    it('can read chats from remote DB', () => {
      const result = reader.getChats('remote-instance', remotePath, { limit: 50, offset: 0 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toHaveLength(2);
    });
  });

  // ── getMessagesByIds ────────────────────────────────────────────────────

  describe('getMessagesByIds', () => {
    let dbPath: string;
    let db: DatabaseSync;
    let msgReader: FleetDbReader;

    beforeEach(() => {
      dbPath = tmpFile();
      db = new DatabaseSync(dbPath);
      db.exec(MINIMAL_SCHEMA);
      db.prepare(`
        INSERT INTO messages (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_type, is_from_me, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('15550100001@s.whatsapp.net', '15550100001', '15550100001@s.whatsapp.net', 'Alice', 'msg-aaa', 'Hello world', 'text', 0, 1700000000);
      db.prepare(`
        INSERT INTO messages (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_type, is_from_me, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('15550100001@s.whatsapp.net', '15550100001', 'bot@s.whatsapp.net', null, 'msg-bbb', 'Hi Alice', 'text', 1, 1700000001);
      db.prepare(`
        INSERT INTO messages (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_type, is_from_me, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('15550100001@s.whatsapp.net', '15550100001', '15550100001@s.whatsapp.net', 'Alice', 'msg-ccc', 'Third message', 'text', 0, 1700000002);
      msgReader = new FleetDbReader('self', db);
    });

    afterEach(() => {
      db.close();
      cleanup(dbPath);
    });

    it('returns matching messages by message_id', () => {
      const result = msgReader.getMessagesByIds('self', dbPath, ['msg-aaa', 'msg-ccc']);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(2);
        expect(result.data.map(r => r.message_id)).toContain('msg-aaa');
        expect(result.data.map(r => r.message_id)).toContain('msg-ccc');
        expect(result.data.find(r => r.message_id === 'msg-aaa')?.content).toBe('Hello world');
        expect(result.data.find(r => r.message_id === 'msg-aaa')?.chat_jid).toBe('15550100001@s.whatsapp.net');
      }
    });

    it('returns empty array for non-existent message_ids', () => {
      const result = msgReader.getMessagesByIds('self', dbPath, ['nonexistent-id']);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toHaveLength(0);
    });

    it('returns empty array for empty input', () => {
      const result = msgReader.getMessagesByIds('self', dbPath, []);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toHaveLength(0);
    });
  });

  // ── searchMessages ─────────────────────────────────────────────────────

  describe('searchMessages', () => {
    it('rejects invalid MATCH syntax before querying SQLite', () => {
      const result = reader.searchMessages('self', '', {
        query: 'bad "quote',
        limit: 10,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/Invalid FTS MATCH query/i);
    });
  });

  // ── getLatestMarkers ────────────────────────────────────────────────────

  describe('getLatestMarkers', () => {
    it('includes message row updates in the message marker', () => {
      selfDb.prepare("UPDATE messages SET updated_at = '2026-01-01T00:00:00.000Z' WHERE conversation_key = '5551234'").run();

      const before = reader.getLatestMarkers('self', '');
      expect(before.ok).toBe(true);
      if (!before.ok) return;

      selfDb.prepare("UPDATE messages SET content = 'upgraded body', updated_at = '2026-01-01T00:00:02.000Z' WHERE conversation_key = '5551234' AND content = 'hello'").run();

      const after = reader.getLatestMarkers('self', '');
      expect(after.ok).toBe(true);
      if (!after.ok) return;

      expect(after.data.latestMessagePk).toBe(before.data.latestMessagePk);
      expect(after.data.latestMessageMarker).not.toBe(before.data.latestMessageMarker);
      expect(after.data.latestMessageMarker).toContain('2026-01-01T00:00:02.000Z');
    });
  });

  // ── getRecentMessagesByChat ─────────────────────────────────────────────

  describe('getRecentMessagesByChat', () => {
    let dbPath: string;
    let db: DatabaseSync;
    let msgReader: FleetDbReader;

    beforeEach(() => {
      dbPath = tmpFile();
      db = new DatabaseSync(dbPath);
      db.exec(MINIMAL_SCHEMA);
      db.prepare(`
        INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content, content_type, is_from_me, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('15550100001@s.whatsapp.net', '15550100001', '15550100001@s.whatsapp.net', 'msg-1', 'First', 'text', 0, 1700000000);
      db.prepare(`
        INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content, content_type, is_from_me, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('15550100001@s.whatsapp.net', '15550100001', '15550100001@s.whatsapp.net', 'msg-2', 'Second', 'text', 0, 1700000003);
      db.prepare(`
        INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content, content_type, is_from_me, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('15550100001@s.whatsapp.net', '15550100001', 'bot@s.whatsapp.net', 'msg-3', 'Reply', 'text', 1, 1700000005);
      msgReader = new FleetDbReader('self', db);
    });

    afterEach(() => {
      db.close();
      cleanup(dbPath);
    });

    it('returns inbound messages near a timestamp', () => {
      const result = msgReader.getRecentMessagesByChat('self', dbPath, '15550100001', 'inbound', 1700000002);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.length).toBeGreaterThanOrEqual(1);
        expect(result.data.every(r => r.is_from_me === 0)).toBe(true);
      }
    });

    it('returns outbound messages when direction is outbound', () => {
      const result = msgReader.getRecentMessagesByChat('self', dbPath, '15550100001', 'outbound', 1700000005);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.length).toBeGreaterThanOrEqual(1);
        expect(result.data.every(r => r.is_from_me === 1)).toBe(true);
      }
    });
  });

  // ── error handling ──────────────────────────────────────────────────────

  describe('error handling', () => {
    it('returns ok:false for missing database file', () => {
      const result = reader.getSummaryStats('missing', '/tmp/does-not-exist-xyz.db');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/open database file/i);
    });

    it('returns ok:false for corrupt database', () => {
      const corruptPath = tmpFile();
      writeFileSync(corruptPath, 'this is not a valid sqlite file');

      const result = reader.getSummaryStats('corrupt', corruptPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeTruthy();

      cleanup(corruptPath);
    });

    it('never throws — always returns DbResult', () => {
      // Even with a completely invalid path, query() catches and returns error
      const result = reader.query('bad', '/dev/null/impossible', (db) => {
        return db.prepare('SELECT 1').all();
      });
      expect(result.ok).toBe(false);
    });
  });
});

// ─── Uncovered-branch coverage ──────────────────────────────────────────────

describe('db-reader.ts uncovered-branch coverage', () => {
  let selfDb: DatabaseSync;
  let reader: FleetDbReader;

  beforeEach(() => {
    selfDb = new DatabaseSync(':memory:');
    seedDb(selfDb);
    reader = new FleetDbReader('self', selfDb);
  });

  afterEach(() => {
    try { selfDb.close(); } catch { /* ok */ }
  });

  // ── buildSafeFtsMatchQuery: empty-query throw branch ───────────────────

  describe('buildSafeFtsMatchQuery empty query', () => {
    it('throws when the query is only whitespace (empty token branch)', () => {
      expect(() => buildSafeFtsMatchQuery('   ')).toThrow(/must not be empty/);
      // And verify via searchMessages that it surfaces as ok:false with the
      // empty-query message (drives the same branch through the reader path).
      const r = reader.searchMessages('self', '', { query: '   ', limit: 5 });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toMatch(/must not be empty/);
    });
  });

  // ── queryWrite: self-instance path ─────────────────────────────────────

  describe('queryWrite', () => {
    it('writes through selfDb for the self instance', () => {
      const res = reader.queryWrite('self', '', (db) => {
        db.prepare('CREATE TABLE IF NOT EXISTS w_test (v INTEGER)').run();
        db.prepare('INSERT INTO w_test (v) VALUES (?)').run(42);
        return db.prepare('SELECT v FROM w_test').get() as { v: number };
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.v).toBe(42);
    });

    it('returns ok:false and surfaces error when self-instance write fails', () => {
      const res = reader.queryWrite('self', '', (db) => {
        // Reference a non-existent table to force a SQL error.
        return db.prepare('SELECT * FROM definitely_not_here').all();
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toMatch(/definitely_not_here|no such table/i);
    });

    it('opens a writable remote connection, writes, and closes', () => {
      const remotePath = tmpFile();
      try {
        const seed = new DatabaseSync(remotePath);
        seedDb(seed);
        seed.close();

        const res = reader.queryWrite('remote', remotePath, (db) => {
          db.prepare('CREATE TABLE IF NOT EXISTS w_remote (v INTEGER)').run();
          db.prepare('INSERT INTO w_remote (v) VALUES (?)').run(7);
          return db.prepare('SELECT COUNT(*) AS c FROM w_remote').get() as { c: number };
        });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.data.c).toBe(1);
      } finally {
        cleanup(remotePath);
      }
    });

    it('returns ok:false when the remote write target cannot be opened', () => {
      // A path whose parent directory does not exist cannot be created/opened.
      const res = reader.queryWrite('remote', '/dev/null/impossible-write-path.db', (db) => {
        return db.prepare('SELECT 1').all();
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      // node:sqlite surfaces this as an open failure.
      expect(typeof res.error).toBe('string');
      expect(res.error.length).toBeGreaterThan(0);
    });
  });

  // ── searchMessages: conversation-scoped branch + valid MATCH success ──

  describe('searchMessages conversation-scoped + hits', () => {
    let ftsPath: string;
    let ftsDb: DatabaseSync;
    let ftsReader: FleetDbReader;

    beforeEach(() => {
      ftsPath = tmpFile();
      ftsDb = new DatabaseSync(ftsPath);
      ftsDb.exec(MINIMAL_SCHEMA);
      const ins = ftsDb.prepare(`
        INSERT INTO messages (chat_jid, conversation_key, sender_jid, sender_name,
                              message_id, content, content_type, is_from_me, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      ins.run('15550000001@s.whatsapp.net', '15550000001', '15550000001@s.whatsapp.net', 'Alice', 'm1', 'hello world', 'text', 0, 1700000000);
      ins.run('15550000002@s.whatsapp.net', '15550000002', '15550000002@s.whatsapp.net', 'Bob', 'm2', 'hello bob', 'text', 0, 1700000010);
      // Sync FTS index after inserts.
      ftsDb.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
      ftsReader = new FleetDbReader('self', ftsDb);
    });

    afterEach(() => {
      ftsDb.close();
      cleanup(ftsPath);
    });

    it('returns hits scoped to a conversationKey', () => {
      const res = ftsReader.searchMessages('self', ftsPath, {
        query: 'hello',
        conversationKey: '15550000001',
        limit: 10,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.every((m) => m.conversation_key === '15550000001')).toBe(true);
      expect(res.data.map((m) => m.message_id)).toContain('m1');
    });

    it('returns hits across all conversations when conversationKey is omitted', () => {
      const res = ftsReader.searchMessages('self', ftsPath, {
        query: 'hello',
        limit: 10,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── getMetrics: all three ranges + densification + provider splits ────

  describe('getMetrics', () => {
    let metricsPath: string;
    let metricsDb: DatabaseSync;
    let metricsReader: FleetDbReader;

    beforeEach(() => {
      metricsPath = tmpFile();
      metricsDb = new DatabaseSync(metricsPath);
      metricsDb.exec(MINIMAL_SCHEMA);
      metricsDb.exec(`
        CREATE TABLE IF NOT EXISTS metrics_hourly (
          bucket TEXT NOT NULL,
          metric TEXT NOT NULL,
          value REAL NOT NULL,
          PRIMARY KEY (bucket, metric)
        );
      `);
      metricsReader = new FleetDbReader('self', metricsDb);
    });

    afterEach(() => {
      metricsDb.close();
      cleanup(metricsPath);
    });

    it('returns a 24h densified report with provider splits and heatmap (range !== 30d)', () => {
      const nowHour = new Date();
      nowHour.setUTCMinutes(0, 0, 0);
      const recentBucket = new Date(nowHour.getTime() - 1 * 60 * 60 * 1000).toISOString();

      const ins = metricsDb.prepare(`INSERT OR REPLACE INTO metrics_hourly (bucket, metric, value) VALUES (?, ?, ?)`);
      ins.run(recentBucket, 'messages_in', 5);
      ins.run(recentBucket, 'messages_out', 2);
      ins.run(recentBucket, 'messages_media', 1);
      ins.run(recentBucket, 'agent_tokens_in', 100);
      ins.run(recentBucket, 'agent_tokens_out', 50);
      ins.run(recentBucket, 'chat_tokens_in', 30);
      ins.run(recentBucket, 'chat_tokens_out', 20);
      ins.run(recentBucket, 'sessions_started', 1);
      ins.run(recentBucket, 'sessions_active', 2);
      // Per-provider suffixed metrics
      ins.run(recentBucket, 'agent_tokens_in:claude-cli', 100);
      ins.run(recentBucket, 'agent_tokens_out:claude-cli', 50);
      ins.run(recentBucket, 'sessions_started:claude-cli', 1);
      ins.run(recentBucket, 'sessions_active:claude-cli', 2);
      // A metric with a colon that is NOT a known base (exercises the else-skip branch + colon split)
      ins.run(recentBucket, 'unknown_metric:someprov', 9);

      const res = metricsReader.getMetrics('self', metricsPath, { range: '24h' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.data.hasMessageData).toBe(true);
      expect(res.data.hasTokenData).toBe(true);
      expect(res.data.hasSessionData).toBe(true);
      expect(res.data.messageVolume).toHaveLength(24);
      expect(res.data.tokenUsage).toHaveLength(24);
      expect(res.data.sessionActivity).toHaveLength(24);
      expect(res.data.activeHours).toHaveLength(7);
      expect(res.data.activeHours[0]).toHaveLength(24);
      expect(res.data.activeHoursByDate).toEqual([]);
      // The reader adds a provider to the set as soon as it sees a colon in
      // the metric name, before checking the base type, so unknown base
      // metrics still surface as a provider entry.
      expect(res.data.providers).toEqual(['claude-cli', 'someprov']);
      const recentBucketEntry = res.data.tokenUsageByProvider['claude-cli'].find((b) => b.bucket === recentBucket);
      expect(recentBucketEntry?.input).toBe(100);
      expect(recentBucketEntry?.output).toBe(50);
      const sessEntry = res.data.sessionActivityByProvider['claude-cli'].find((b) => b.bucket === recentBucket);
      expect(sessEntry?.started).toBe(1);
      expect(sessEntry?.active).toBe(2);
    });

    it('returns a 7d report (range !== 30d, still uses dow heatmap)', () => {
      const res = metricsReader.getMetrics('self', metricsPath, { range: '7d' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.tokenUsage).toHaveLength(168);
      expect(res.data.activeHoursByDate).toEqual([]);
      expect(res.data.hasMessageData).toBe(false);
      expect(res.data.providers).toEqual([]);
    });

    it('returns a 30d report with per-date heatmap (range === 30d)', () => {
      // Seed one raw message well inside the 30d cutoff to populate activeHoursByDate.
      const cutoffSec = Math.floor((Date.now() - 720 * 60 * 60 * 1000) / 1000);
      const msgIns = metricsDb.prepare(`
        INSERT INTO messages (chat_jid, conversation_key, sender_jid, sender_name,
                              message_id, content, content_type, is_from_me, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      msgIns.run(
        '15550000003@s.whatsapp.net', '15550000003', '15550000003@s.whatsapp.net',
        'Carol', 'm-30d', 'recent body', 'text', 0, cutoffSec + 60,
      );
      // Second message on the SAME date but a DIFFERENT hour, to exercise the
      // `if (!hours)` false-branch (existing hours array gets reused).
      msgIns.run(
        '15550000003@s.whatsapp.net', '15550000003', '15550000003@s.whatsapp.net',
        'Carol', 'm-30d-2', 'second body', 'text', 0, cutoffSec + 60 + 3600,
      );

      const res = metricsReader.getMetrics('self', metricsPath, { range: '30d' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.tokenUsage).toHaveLength(720);
      // 30d range skips the dow heatmap query (still a 7x24 zero grid).
      expect(res.data.activeHours).toHaveLength(7);
      expect(res.data.activeHours.every((row) => row.every((v) => v === 0))).toBe(true);
      // Per-date heatmap should have at least one entry from the seeded messages.
      expect(res.data.activeHoursByDate.length).toBeGreaterThan(0);
      const totalHours = res.data.activeHoursByDate.reduce(
        (sum, e) => sum + e.hours.reduce((a, b) => a + b, 0), 0,
      );
      expect(totalHours).toBe(2);
    });

    it('reuses a bucket map entry when multiple metrics target the same provider/bucket', () => {
      const nowHour = new Date();
      nowHour.setUTCMinutes(0, 0, 0);
      const recentBucket = new Date(nowHour.getTime() - 1 * 60 * 60 * 1000).toISOString();
      const ins = metricsDb.prepare(`INSERT OR REPLACE INTO metrics_hourly (bucket, metric, value) VALUES (?, ?, ?)`);
      // Same provider+bucket: both tokens and sessions, exercising the
      // existing-entry merge path in the provider maps.
      ins.run(recentBucket, 'agent_tokens_in:provX', 10);
      ins.run(recentBucket, 'agent_tokens_out:provX', 4);
      ins.run(recentBucket, 'sessions_started:provX', 1);
      ins.run(recentBucket, 'sessions_active:provX', 1);

      const res = metricsReader.getMetrics('self', metricsPath, { range: '24h' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.providers).toEqual(['provX']);
      const tok = res.data.tokenUsageByProvider['provX'].find((b) => b.bucket === recentBucket);
      expect(tok).toMatchObject({ input: 10, output: 4 });
      const sess = res.data.sessionActivityByProvider['provX'].find((b) => b.bucket === recentBucket);
      expect(sess).toMatchObject({ started: 1, active: 1 });
    });
  });

  // ── getLatestMarkers: empty-messages branch (msgRow null) ─────────────

  describe('getLatestMarkers empty DB', () => {
    it('returns null markers when there are no messages and no access rows', () => {
      const emptyDb = new DatabaseSync(':memory:');
      emptyDb.exec(MINIMAL_SCHEMA);
      // No messages, no access_list rows.
      const emptyReader = new FleetDbReader('self', emptyDb);
      const res = emptyReader.getLatestMarkers('self', '');
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.latestMessagePk).toBeNull();
      expect(res.data.latestMessageMarker).toBeNull();
      expect(res.data.latestAccessMarker).toBeNull();
      emptyDb.close();
    });

    it('uses updated_at branch when the messages table has that column', () => {
      // selfDb from beforeEach already has updated_at in MINIMAL_SCHEMA;
      // exercising the path again with a set value proves the true-branch
      // produces a non-null marker containing the updated_at.
      selfDb.prepare("UPDATE messages SET updated_at = '2026-06-01T00:00:00.000Z' WHERE pk = (SELECT MIN(pk) FROM messages)").run();
      const res = reader.getLatestMarkers('self', '');
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.latestMessagePk).not.toBeNull();
      expect(res.data.latestMessageMarker).toContain('2026-06-01T00:00:00.000Z');
    });

    it('falls back to the no-updated_at branch when the column is absent', () => {
      const noUpdatedDb = new DatabaseSync(':memory:');
      noUpdatedDb.exec(`
        CREATE TABLE messages (
          pk INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_jid TEXT NOT NULL,
          conversation_key TEXT NOT NULL,
          sender_jid TEXT NOT NULL,
          sender_name TEXT,
          message_id TEXT,
          content TEXT,
          content_type TEXT NOT NULL DEFAULT 'text',
          is_from_me INTEGER NOT NULL DEFAULT 0,
          timestamp INTEGER NOT NULL,
          deleted_at TEXT
        );
        CREATE TABLE access_list (
          subject_type TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          status TEXT NOT NULL,
          display_name TEXT,
          requested_at TEXT,
          decided_at TEXT,
          PRIMARY KEY (subject_type, subject_id)
        );
      `);
      noUpdatedDb.prepare(`
        INSERT INTO messages (chat_jid, conversation_key, sender_jid, sender_name, content, content_type, is_from_me, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('15550000004@s.whatsapp.net', '15550000004', '15550000004@s.whatsapp.net', 'Dan', 'hi', 'text', 0, 1700000100);
      noUpdatedDb.prepare(`
        INSERT INTO access_list (subject_type, subject_id, status, requested_at)
        VALUES (?, ?, ?, ?)
      `).run('phone', '15550000004', 'pending', '2026-06-01T00:00:00');

      const noUpdatedReader = new FleetDbReader('self', noUpdatedDb);
      const res = noUpdatedReader.getLatestMarkers('self', '');
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.latestMessagePk).toBe(1);
      // updated_at fallback appends an empty string segment.
      expect(res.data.latestMessageMarker).toBe('1:');
      expect(res.data.latestAccessMarker).toBe('2026-06-01T00:00:00');
      noUpdatedDb.close();
    });
  });

  // ── getRecentMessagesByChat: default-arg limit + ordering ─────────────

  describe('getRecentMessagesByChat default limit', () => {
    it('applies the default limit of 3 when none is passed', () => {
      const recPath = tmpFile();
      const recDb = new DatabaseSync(recPath);
      try {
        recDb.exec(MINIMAL_SCHEMA);
        const ins = recDb.prepare(`
          INSERT INTO messages (chat_jid, conversation_key, sender_jid, sender_name,
                                message_id, content, content_type, is_from_me, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        // 5 inbound messages clustered tightly around t=1000.
        ins.run('15550000005@s.whatsapp.net', '15550000005', '15550000005@s.whatsapp.net', 'Eve', 'msg-a', 'a', 'text', 0,  998);
        ins.run('15550000005@s.whatsapp.net', '15550000005', '15550000005@s.whatsapp.net', 'Eve', 'msg-b', 'b', 'text', 0,  999);
        ins.run('15550000005@s.whatsapp.net', '15550000005', '15550000005@s.whatsapp.net', 'Eve', 'msg-c', 'c', 'text', 0, 1000);
        ins.run('15550000005@s.whatsapp.net', '15550000005', '15550000005@s.whatsapp.net', 'Eve', 'msg-d', 'd', 'text', 0, 1001);
        ins.run('15550000005@s.whatsapp.net', '15550000005', '15550000005@s.whatsapp.net', 'Eve', 'msg-e', 'e', 'text', 0, 1002);

        const recReader = new FleetDbReader('self', recDb);
        const res = recReader.getRecentMessagesByChat('self', recPath, '15550000005', 'inbound', 1000);
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        // Default limit=3 caps the result even though 5 are within the window.
        expect(res.data).toHaveLength(3);
        expect(res.data.every((m) => m.is_from_me === 0)).toBe(true);
        // Nearest-by-ABS(t-1000) ordering: the closest message content first.
        expect(res.data[0].content).toBe('c');
      } finally {
        recDb.close();
        cleanup(recPath);
      }
    });
  });

  // ── getSummaryStats: ?? 0 fallback when COUNT returns nullish ─────────

  describe('getSummaryStats nullish fallbacks', () => {
    it('returns 0 counts when the messages table is empty', () => {
      const emptyDb = new DatabaseSync(':memory:');
      emptyDb.exec(MINIMAL_SCHEMA);
      const emptyReader = new FleetDbReader('self', emptyDb);
      const res = emptyReader.getSummaryStats('self', '');
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data).toEqual({ messageCount: 0, chatCount: 0, pendingAccess: 0 });
      emptyDb.close();
    });
  });
});
