import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync, writeFileSync } from 'node:fs';
import { FleetDbReader } from '../../src/fleet/db-reader.ts';
import type { MessageRow, AccessEntry } from '../../src/fleet/db-reader.ts';

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

  // ── error handling ──────────────────────────────────────────────────────

  describe('error handling', () => {
    it('returns ok:false for missing database file', () => {
      const result = reader.getSummaryStats('missing', '/tmp/does-not-exist-xyz.db');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeTruthy();
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
