import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';

const cleanupTargets: string[] = [];

function tmpFile(prefix = 'whatsoup-db-edge'): string {
  const path = join(tmpdir(), `${prefix}-${randomBytes(8).toString('hex')}.db`);
  cleanupTargets.push(path);
  return path;
}

function tmpDir(prefix = 'whatsoup-db-edge'): string {
  const path = mkdtempSync(join(tmpdir(), `${prefix}-`));
  cleanupTargets.push(path);
  return path;
}

function cleanupPath(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const full = path + suffix;
    if (!existsSync(full)) continue;
    try {
      rmSync(full, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

afterEach(() => {
  for (const target of cleanupTargets.splice(0)) {
    cleanupPath(target);
  }
});

describe('Database constructor and close error paths', () => {
  it('wraps directory creation failures when the parent path is a file', () => {
    const parentFile = tmpFile('whatsoup-db-parent-file');
    writeFileSync(parentFile, 'not a directory');

    expect(() => new Database(join(parentFile, 'bot.db'))).toThrow(/Cannot create DB directory/);
  });

  it('wraps sqlite open failures when the database path is a directory', () => {
    const dir = tmpDir('whatsoup-db-directory');

    expect(() => new Database(dir)).toThrow(/Cannot open database at/);
  });

  it('does not throw when close is called after the connection is already closed', () => {
    const db = new Database(':memory:');
    db.open();
    db.close();

    expect(() => db.close()).not.toThrow();
  });
});

describe('Database migration error and rewrite paths', () => {
  it('wraps schema_migrations creation failures caused by sqlite name collisions', () => {
    const dbPath = tmpFile('whatsoup-db-migration-name-collision');
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE collision_base (value INTEGER);
      CREATE INDEX schema_migrations ON collision_base(value);
    `);
    raw.close();

    const db = new Database(dbPath);
    try {
      expect(() => db.open()).toThrow(/Failed to create schema_migrations table/);
    } finally {
      db.close();
    }
  });

  it('rolls back a failed pending migration without recording its version', () => {
    const dbPath = tmpFile('whatsoup-db-migration-failure');
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    const insertVersion = raw.prepare('INSERT INTO schema_migrations (version) VALUES (?)');
    for (let version = 1; version <= 15; version += 1) {
      insertVersion.run(version);
    }
    raw.close();

    const db = new Database(dbPath);
    try {
      expect(() => db.open()).toThrow(/Migration 16 failed/);
    } finally {
      db.close();
    }

    const check = new DatabaseSync(dbPath);
    const versions = check
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number }>;
    check.close();
    expect(versions.map((row) => row.version)).toEqual(
      Array.from({ length: 15 }, (_unused, index) => index + 1),
    );
  });

  it('rewrites old outbound_sends schema to allow rgp caller without losing rows', () => {
    const dbPath = tmpFile('whatsoup-db-migration-26');
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE outbound_sends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        line TEXT NOT NULL,
        caller TEXT NOT NULL CHECK (caller IN ('mcp', 'health')),
        chat_jid TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK (target_kind IN ('chatJid', 'alias')),
        alias TEXT,
        profile TEXT,
        text_hash TEXT NOT NULL,
        text_length INTEGER NOT NULL,
        link_preview_mode TEXT CHECK (link_preview_mode IN ('auto', 'off') OR link_preview_mode IS NULL),
        status TEXT NOT NULL DEFAULT 'intent' CHECK (status IN ('intent', 'sent', 'failed')),
        error TEXT,
        transport_message_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );
      INSERT INTO outbound_sends
        (line, caller, chat_jid, target_kind, alias, profile, text_hash, text_length, link_preview_mode, status, error, transport_message_id, created_at, completed_at)
      VALUES
        ('personal', 'mcp', '15550100001@s.whatsapp.net', 'chatJid', NULL, 'notify', 'abc123', 12, 'off', 'sent', NULL, 'wamid.old', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z');
    `);
    const insertVersion = raw.prepare('INSERT INTO schema_migrations (version) VALUES (?)');
    for (let version = 1; version <= 25; version += 1) {
      insertVersion.run(version);
    }
    raw.close();

    const db = new Database(dbPath);
    try {
      db.open();
      const table = db.raw
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbound_sends'")
        .get() as { sql: string };
      expect(table.sql).toContain("'rgp'");

      const preserved = db.raw
        .prepare('SELECT caller, status, transport_message_id FROM outbound_sends WHERE id = 1')
        .get() as { caller: string; status: string; transport_message_id: string };
      expect(preserved).toEqual({ caller: 'mcp', status: 'sent', transport_message_id: 'wamid.old' });

      expect(() => {
        db.raw.prepare(`
          INSERT INTO outbound_sends
            (line, caller, chat_jid, target_kind, text_hash, text_length, status)
          VALUES
            ('personal', 'rgp', '15550100002@s.whatsapp.net', 'chatJid', 'def456', 9, 'intent')
        `).run();
      }).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe('Database legacy import edge paths', () => {
  it('skips unrecognized optional legacy schemas and invalid message JIDs', () => {
    const legacyPath = tmpFile('whatsoup-db-legacy-skips');
    const targetPath = tmpFile('whatsoup-db-legacy-target');
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE messages (
        pk INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_jid TEXT NOT NULL,
        sender_jid TEXT NOT NULL,
        sender_name TEXT,
        message_id TEXT UNIQUE,
        content TEXT,
        content_type TEXT NOT NULL DEFAULT 'text',
        is_from_me INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL,
        quoted_message_id TEXT,
        enrichment_processed_at TEXT,
        enrichment_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE access_list (
        legacy_subject TEXT PRIMARY KEY,
        status TEXT NOT NULL
      );
      CREATE TABLE agent_sessions (
        id INTEGER PRIMARY KEY,
        session_id TEXT
      );
      CREATE TABLE rate_limits (
        legacy_sender TEXT NOT NULL
      );
      CREATE TABLE enrichment_runs (
        run_id INTEGER PRIMARY KEY,
        started_at TEXT NOT NULL
      );
      INSERT INTO messages
        (chat_jid, sender_jid, sender_name, message_id, content, content_type, is_from_me, timestamp, created_at)
      VALUES
        ('not-a-jid', 'sender@s.whatsapp.net', 'Sender', 'bad-jid-message', 'ignored', 'text', 0, 1700000000, datetime('now'));
      INSERT INTO access_list (legacy_subject, status) VALUES ('legacy-only', 'allowed');
      INSERT INTO agent_sessions (id, session_id) VALUES (1, 'legacy-session');
      INSERT INTO rate_limits (legacy_sender) VALUES ('sender@s.whatsapp.net');
      INSERT INTO enrichment_runs (run_id, started_at) VALUES (1, datetime('now'));
    `);
    legacy.close();

    const target = new Database(targetPath);
    try {
      target.open();
      target.importFromLegacyDb(legacyPath);

      expect((target.raw.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n).toBe(0);
      expect((target.raw.prepare('SELECT count(*) AS n FROM access_list').get() as { n: number }).n).toBe(0);
      expect((target.raw.prepare('SELECT count(*) AS n FROM agent_sessions').get() as { n: number }).n).toBe(0);
      expect((target.raw.prepare('SELECT count(*) AS n FROM rate_limits').get() as { n: number }).n).toBe(0);
      expect((target.raw.prepare('SELECT count(*) AS n FROM enrichment_runs').get() as { n: number }).n).toBe(0);
    } finally {
      target.close();
    }
  });

  it('wraps attach failures before starting an import transaction', () => {
    const legacyDir = tmpDir('whatsoup-db-legacy-dir');
    const targetPath = tmpFile('whatsoup-db-attach-target');
    const target = new Database(targetPath);

    try {
      target.open();
      expect(() => target.importFromLegacyDb(legacyDir)).toThrow(/Failed to ATTACH legacy database/);
    } finally {
      target.close();
    }
  });

  it('rolls back legacy rows if the required messages table is missing', () => {
    const legacyPath = tmpFile('whatsoup-db-legacy-rollback');
    const targetPath = tmpFile('whatsoup-db-rollback-target');
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE access_list (
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        status TEXT NOT NULL,
        display_name TEXT,
        requested_at TEXT,
        decided_at TEXT,
        PRIMARY KEY (subject_type, subject_id)
      );
      INSERT INTO access_list (subject_type, subject_id, status, display_name, requested_at)
      VALUES ('phone', '15550109999', 'allowed', 'Rollback User', datetime('now'));
    `);
    legacy.close();

    const target = new Database(targetPath);
    try {
      target.open();
      expect(() => target.importFromLegacyDb(legacyPath)).toThrow(/Warm-start import failed/);

      const imported = target.raw
        .prepare("SELECT status FROM access_list WHERE subject_type = 'phone' AND subject_id = '15550109999'")
        .get() as { status: string } | undefined;
      expect(imported).toBeUndefined();

      const attached = target.raw.prepare('PRAGMA database_list').all() as Array<{ name: string }>;
      expect(attached.some((row) => row.name === 'old')).toBe(false);
    } finally {
      target.close();
    }
  });
});

describe('Database clearChat', () => {
  it('soft-deletes only active messages for the requested conversation and removes them from FTS', () => {
    const db = new Database(':memory:');
    db.open();

    try {
      const insert = db.raw.prepare(`
        INSERT INTO messages
          (chat_jid, conversation_key, sender_jid, message_id, content, content_text, content_type, is_from_me, timestamp, deleted_at)
        VALUES
          (?, ?, ?, ?, ?, ?, 'text', 0, ?, ?)
      `);
      insert.run('15550100001@s.whatsapp.net', 'clear-target', '15550100001@s.whatsapp.net', 'clear-1', 'clearalpha body', 'clearalpha body', 1_700_000_001, null);
      insert.run('15550100001@s.whatsapp.net', 'clear-target', '15550100001@s.whatsapp.net', 'clear-2', 'clearbeta body', 'clearbeta body', 1_700_000_002, null);
      insert.run('15550100001@s.whatsapp.net', 'clear-target', '15550100001@s.whatsapp.net', 'clear-old', 'clearold body', 'clearold body', 1_700_000_003, '2026-01-01T00:00:00.000Z');
      insert.run('15550100002@s.whatsapp.net', 'keep-target', '15550100002@s.whatsapp.net', 'keep-1', 'keepgamma body', 'keepgamma body', 1_700_000_004, null);

      const match = (term: string) => (
        db.raw.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all(term) as Array<{ rowid: number }>
      ).map((row) => row.rowid);

      expect(match('clearalpha')).toHaveLength(1);
      expect(match('clearbeta')).toHaveLength(1);
      expect(match('keepgamma')).toHaveLength(1);

      expect(db.clearChat('clear-target')).toBe(2);
      expect(db.clearChat('clear-target')).toBe(0);

      const rows = db.raw.prepare(`
        SELECT message_id, deleted_at
        FROM messages
        ORDER BY message_id
      `).all() as Array<{ message_id: string; deleted_at: string | null }>;
      expect(rows.find((row) => row.message_id === 'clear-1')?.deleted_at).toEqual(expect.any(String));
      expect(rows.find((row) => row.message_id === 'clear-2')?.deleted_at).toEqual(expect.any(String));
      expect(rows.find((row) => row.message_id === 'clear-old')?.deleted_at).toBe('2026-01-01T00:00:00.000Z');
      expect(rows.find((row) => row.message_id === 'keep-1')?.deleted_at).toBeNull();
      expect(match('clearalpha')).toHaveLength(0);
      expect(match('clearbeta')).toHaveLength(0);
      expect(match('keepgamma')).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
