import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, CURRENT_SCHEMA_MIGRATION } from '../../src/core/database.ts';
import { runMigration47 } from '../../src/core/database-migration-47.ts';

function openLinkedReceiptDatabase(): { raw: DatabaseSync; sourceSeq: number } {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`
    CREATE TABLE inbound_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      conversation_key TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
    CREATE TABLE turn_recovery_jobs (
      id INTEGER PRIMARY KEY,
      source_inbound_seq INTEGER NOT NULL
    );
  `);
  runMigration47(raw);
  raw.prepare(`
    INSERT INTO inbound_events (
      message_id, conversation_key, chat_jid, received_at
    ) VALUES ('linked-message', 'conversation', 'chat', '2026-05-26 00:00:00')
  `).run();
  const source = raw.prepare(`
    SELECT seq FROM inbound_events WHERE message_id = 'linked-message'
  `).get() as { seq: number };
  raw.prepare(`
    INSERT INTO turn_recovery_jobs (id, source_inbound_seq) VALUES (1, ?)
  `).run(source.seq);
  return { raw, sourceSeq: source.seq };
}

function linkedReceipt(raw: DatabaseSync): unknown {
  return raw.prepare(`
    SELECT i.seq, i.message_id, unixepoch(i.received_at) AS received_at_unix_seconds
    FROM turn_recovery_jobs j
    JOIN inbound_events i ON i.seq = j.source_inbound_seq
    WHERE j.id = 1
  `).get();
}

describe('migration 47 recovery receipt immutability', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => db.close());

  it('installs dedicated receipt update and replacement fences', () => {
    expect(CURRENT_SCHEMA_MIGRATION).toBe(56);
    expect(db.raw.prepare(
      'SELECT version FROM schema_migrations WHERE version = 47',
    ).get()).toEqual({ version: 47 });

    const trigger = db.raw.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger'
        AND name = 'turn_recovery_source_inbound_receipt_immutable'
    `).get() as { sql: string } | undefined;
    expect(trigger?.sql).toContain('BEFORE UPDATE OF seq, received_at ON inbound_events');
    expect(trigger?.sql).toContain('j.source_inbound_seq = OLD.seq');
    expect(trigger?.sql).toContain('NEW.seq IS NOT OLD.seq');
    expect(trigger?.sql).toContain('NEW.received_at IS NOT OLD.received_at');

    const replacementTrigger = db.raw.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger'
        AND name = 'turn_recovery_source_inbound_replacement_blocked'
    `).get() as { sql: string } | undefined;
    expect(replacementTrigger?.sql).toContain('BEFORE INSERT ON inbound_events');
    expect(replacementTrigger?.sql).toContain('existing.seq = NEW.seq');
    expect(replacementTrigger?.sql).toContain('existing.message_id = NEW.message_id');

    const updateReplacementTrigger = db.raw.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger'
        AND name = 'turn_recovery_source_inbound_update_replacement_blocked'
    `).get() as { sql: string } | undefined;
    expect(updateReplacementTrigger?.sql).toContain(
      'BEFORE UPDATE OF seq, message_id ON inbound_events',
    );
    expect(updateReplacementTrigger?.sql).toContain('existing.seq IS NOT OLD.seq');
    expect(updateReplacementTrigger?.sql).toContain('existing.seq = NEW.seq');
    expect(updateReplacementTrigger?.sql).toContain(
      'existing.message_id = NEW.message_id',
    );
  });

  it('does not block receipt correction or replacement before a recovery job is linked', () => {
    db.raw.prepare(`
      INSERT INTO inbound_events (message_id, conversation_key, chat_jid)
      VALUES ('unlinked-receipt', 'conversation', 'chat')
    `).run();

    expect(() => db.raw.prepare(`
      UPDATE inbound_events
      SET received_at = datetime(received_at, '+1 second')
      WHERE message_id = 'unlinked-receipt'
    `).run()).not.toThrow();
    expect(() => db.raw.prepare(`
      UPDATE inbound_events
      SET seq = seq + 100
      WHERE message_id = 'unlinked-receipt'
    `).run()).not.toThrow();
    expect(() => db.raw.prepare(`
      UPDATE OR REPLACE inbound_events
      SET message_id = 'unlinked-receipt-renamed'
      WHERE message_id = 'unlinked-receipt'
    `).run()).not.toThrow();

    expect(() => db.raw.prepare(`
      INSERT OR REPLACE INTO inbound_events (
        seq, message_id, conversation_key, chat_jid, received_at
      )
      SELECT
        seq, message_id, conversation_key, chat_jid,
        datetime(received_at, '+1 second')
      FROM inbound_events
      WHERE message_id = 'unlinked-receipt-renamed'
    `).run()).not.toThrow();
  });

  it('is idempotent and fails closed on a partial parent schema', () => {
    expect(() => runMigration47(db.raw)).not.toThrow();

    const partial = new DatabaseSync(':memory:');
    try {
      expect(() => runMigration47(partial)).toThrow(
        'migration 47 missing required tables: inbound_events, turn_recovery_jobs',
      );
    } finally {
      partial.close();
    }
  });

  it('restores a missing canonical replacement fence without rewriting the update fence', () => {
    const updateSql = db.raw.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger'
        AND name = 'turn_recovery_source_inbound_receipt_immutable'
    `).get();
    db.raw.exec('DROP TRIGGER turn_recovery_source_inbound_replacement_blocked');

    expect(() => runMigration47(db.raw)).not.toThrow();
    expect(db.raw.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger'
        AND name = 'turn_recovery_source_inbound_receipt_immutable'
    `).get()).toEqual(updateSql);
    expect(db.raw.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger'
        AND name = 'turn_recovery_source_inbound_replacement_blocked'
    `).get()).toEqual({
      name: 'turn_recovery_source_inbound_replacement_blocked',
    });
  });

  it('restores a missing update replacement fence without rewriting its peers', () => {
    const immutableSql = db.raw.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger'
        AND name = 'turn_recovery_source_inbound_receipt_immutable'
    `).get();
    const insertReplacementSql = db.raw.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger'
        AND name = 'turn_recovery_source_inbound_replacement_blocked'
    `).get();
    db.raw.exec('DROP TRIGGER turn_recovery_source_inbound_update_replacement_blocked');

    expect(() => runMigration47(db.raw)).not.toThrow();
    expect(db.raw.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger'
        AND name = 'turn_recovery_source_inbound_receipt_immutable'
    `).get()).toEqual(immutableSql);
    expect(db.raw.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger'
        AND name = 'turn_recovery_source_inbound_replacement_blocked'
    `).get()).toEqual(insertReplacementSql);
    expect(db.raw.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger'
        AND name = 'turn_recovery_source_inbound_update_replacement_blocked'
    `).get()).toEqual({
      name: 'turn_recovery_source_inbound_update_replacement_blocked',
    });
  });

  it('rejects missing columns and a drifted same-name trigger', () => {
    const missingColumn = new DatabaseSync(':memory:');
    try {
      missingColumn.exec(`
        CREATE TABLE inbound_events (seq INTEGER PRIMARY KEY);
        CREATE TABLE turn_recovery_jobs (source_inbound_seq INTEGER);
      `);
      expect(() => runMigration47(missingColumn)).toThrow(
        'migration 47 inbound_events missing required columns: message_id, received_at',
      );
      expect(missingColumn.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger'
          AND name = 'turn_recovery_source_inbound_receipt_immutable'
      `).get()).toBeUndefined();
    } finally {
      missingColumn.close();
    }

    db.raw.exec(`
      DROP TRIGGER turn_recovery_source_inbound_receipt_immutable;
      CREATE TRIGGER turn_recovery_source_inbound_receipt_immutable
      BEFORE UPDATE OF received_at ON inbound_events
      BEGIN
        SELECT 1;
      END;
    `);
    expect(() => runMigration47(db.raw)).toThrow(
      'migration 47 found drifted trigger: turn_recovery_source_inbound_receipt_immutable',
    );
  });

  it('fails closed on a drifted replacement fence', () => {
    db.raw.exec(`
      DROP TRIGGER turn_recovery_source_inbound_replacement_blocked;
      CREATE TRIGGER turn_recovery_source_inbound_replacement_blocked
      BEFORE INSERT ON inbound_events
      BEGIN
        SELECT 1;
      END;
    `);
    expect(() => runMigration47(db.raw)).toThrow(
      'migration 47 found drifted trigger: turn_recovery_source_inbound_replacement_blocked',
    );
  });

  it('fails closed on a drifted update replacement fence', () => {
    db.raw.exec(`
      DROP TRIGGER turn_recovery_source_inbound_update_replacement_blocked;
      CREATE TRIGGER turn_recovery_source_inbound_update_replacement_blocked
      BEFORE UPDATE OF seq ON inbound_events
      BEGIN
        SELECT 1;
      END;
    `);
    expect(() => runMigration47(db.raw)).toThrow(
      'migration 47 found drifted trigger: turn_recovery_source_inbound_update_replacement_blocked',
    );
  });

  it('rejects linked replacement at the same inbound sequence', () => {
    const linked = openLinkedReceiptDatabase();
    try {
      const before = linkedReceipt(linked.raw);
      expect(() => linked.raw.prepare(`
        INSERT OR REPLACE INTO inbound_events (
          seq, message_id, conversation_key, chat_jid, received_at
        ) VALUES (?, 'linked-message', 'conversation', 'chat', '2040-01-01 00:00:00')
      `).run(linked.sourceSeq)).toThrow(/recovery source inbound replacement is blocked/i);
      expect(linkedReceipt(linked.raw)).toEqual(before);
    } finally {
      linked.raw.close();
    }
  });

  it('rejects changing a linked journal sequence while allowing a no-op assignment', () => {
    const linked = openLinkedReceiptDatabase();
    try {
      const before = linkedReceipt(linked.raw);
      expect(() => linked.raw.prepare(`
        UPDATE inbound_events SET seq = seq + 100 WHERE seq = ?
      `).run(linked.sourceSeq)).toThrow(/recovery source inbound receipt is immutable/i);
      expect(linkedReceipt(linked.raw)).toEqual(before);

      expect(() => linked.raw.prepare(`
        UPDATE inbound_events SET seq = seq WHERE seq = ?
      `).run(linked.sourceSeq)).not.toThrow();
      expect(linkedReceipt(linked.raw)).toEqual(before);
    } finally {
      linked.raw.close();
    }
  });

  it('rejects linked replacement by message id when the sequence is omitted', () => {
    const linked = openLinkedReceiptDatabase();
    try {
      const before = linkedReceipt(linked.raw);
      expect(() => linked.raw.prepare(`
        INSERT OR REPLACE INTO inbound_events (
          message_id, conversation_key, chat_jid, received_at
        ) VALUES ('linked-message', 'conversation', 'chat', '2040-01-01 00:00:00')
      `).run()).toThrow(/recovery source inbound replacement is blocked/i);
      expect(linkedReceipt(linked.raw)).toEqual(before);
      expect(linked.raw.prepare(`
        SELECT source_inbound_seq FROM turn_recovery_jobs WHERE id = 1
      `).get()).toEqual({ source_inbound_seq: linked.sourceSeq });
    } finally {
      linked.raw.close();
    }
  });

  it('rejects UPDATE OR REPLACE of another row by a linked message id', () => {
    const linked = openLinkedReceiptDatabase();
    try {
      linked.raw.exec('PRAGMA recursive_triggers = OFF');
      linked.raw.prepare(`
        INSERT INTO inbound_events (
          message_id, conversation_key, chat_jid, received_at
        ) VALUES ('unlinked-message', 'conversation', 'chat', '2030-01-01 00:00:00')
      `).run();
      const before = linkedReceipt(linked.raw);

      expect(() => linked.raw.prepare(`
        UPDATE OR REPLACE inbound_events
        SET message_id = 'linked-message'
        WHERE message_id = 'unlinked-message'
      `).run()).toThrow(/recovery source inbound update replacement is blocked/i);
      expect(linkedReceipt(linked.raw)).toEqual(before);
      expect(linked.raw.prepare(`
        SELECT message_id FROM inbound_events WHERE message_id = 'unlinked-message'
      `).get()).toEqual({ message_id: 'unlinked-message' });
    } finally {
      linked.raw.close();
    }
  });

  it('rejects UPDATE OR REPLACE of another row by a linked sequence', () => {
    const linked = openLinkedReceiptDatabase();
    try {
      linked.raw.exec('PRAGMA recursive_triggers = OFF');
      linked.raw.prepare(`
        INSERT INTO inbound_events (
          message_id, conversation_key, chat_jid, received_at
        ) VALUES ('unlinked-message', 'conversation', 'chat', '2030-01-01 00:00:00')
      `).run();
      const before = linkedReceipt(linked.raw);

      expect(() => linked.raw.prepare(`
        UPDATE OR REPLACE inbound_events
        SET seq = ?, received_at = '2040-01-01 00:00:00'
        WHERE message_id = 'unlinked-message'
      `).run(linked.sourceSeq)).toThrow(
        /recovery source inbound update replacement is blocked/i,
      );
      expect(linkedReceipt(linked.raw)).toEqual(before);
      expect(linked.raw.prepare(`
        SELECT message_id FROM inbound_events WHERE message_id = 'unlinked-message'
      `).get()).toEqual({ message_id: 'unlinked-message' });
    } finally {
      linked.raw.close();
    }
  });
});
