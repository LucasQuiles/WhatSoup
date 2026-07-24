// tests/lib/db-query.test.ts
// Tests for the typed queryAll/queryOne wrappers (#2191).
// Verifies the wrappers return typed rows from real node:sqlite and handle
// the single-row and no-row cases correctly.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { queryAll, queryOne } from '../../src/lib/db-query.ts';

describe('queryAll / queryOne — typed SQLite wrappers (#2191)', () => {
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    dbPath = mkdtempSync(join(tmpdir(), 'whatsoup-db-query-'));
    db = new DatabaseSync(join(dbPath, 'test.db'));
    db.exec(`
      CREATE TABLE messages (
        pk INTEGER PRIMARY KEY,
        conversation_key TEXT NOT NULL,
        content TEXT,
        is_from_me INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO messages (conversation_key, content, is_from_me) VALUES
        ('chat-a@s.whatsapp.net', 'hello', 0),
        ('chat-a@s.whatsapp.net', 'hi back', 1),
        ('chat-b@s.whatsapp.net', 'ping', 0);
    `);
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { recursive: true, force: true });
  });

  it('queryAll returns typed rows matching the generic type', () => {
    interface Row { pk: number; conversation_key: string; content: string | null }
    const rows = queryAll<Row>(db, 'SELECT pk, conversation_key, content FROM messages ORDER BY pk');

    expect(rows).toHaveLength(3);
    expect(rows[0]!.conversation_key).toBe('chat-a@s.whatsapp.net');
    expect(rows[0]!.content).toBe('hello');
    expect(rows[1]!.content).toBe('hi back');
  });

  it('queryAll accepts bound parameters', () => {
    interface Row { pk: number }
    const rows = queryAll<Row>(db, 'SELECT pk FROM messages WHERE conversation_key = ? ORDER BY pk', 'chat-a@s.whatsapp.net');

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.pk)).toEqual([1, 2]);
  });

  it('queryAll returns an empty array when no rows match', () => {
    interface Row { pk: number }
    const rows = queryAll<Row>(db, 'SELECT pk FROM messages WHERE conversation_key = ?', 'nonexistent');

    expect(rows).toEqual([]);
  });

  it('queryOne returns a single typed row or undefined', () => {
    interface CountRow { c: number }
    const row = queryOne<CountRow>(db, 'SELECT COUNT(*) as c FROM messages');

    expect(row).toBeDefined();
    expect(row!.c).toBe(3);
  });

  it('queryOne returns undefined when no row matches', () => {
    interface Row { pk: number }
    const row = queryOne<Row>(db, 'SELECT pk FROM messages WHERE pk = ?', 999);

    expect(row).toBeUndefined();
  });

  it('queryOne accepts bound parameters', () => {
    interface Row { content: string | null }
    const row = queryOne<Row>(db, 'SELECT content FROM messages WHERE pk = ?', 2);

    expect(row).toBeDefined();
    expect(row!.content).toBe('hi back');
  });
});
