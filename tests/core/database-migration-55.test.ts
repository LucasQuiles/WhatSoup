import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigration55 } from '../../src/core/database-migration-55.ts';
import { CURRENT_SCHEMA_MIGRATION, Database } from '../../src/core/database.ts';

/**
 * Legacy (v54) inbound_events shape: 13 columns, continuity CHECKs, and NO
 * processing_status CHECK constraint.
 */
function createLegacyInboundEvents(raw: DatabaseSync): void {
  raw.exec(`
    CREATE TABLE inbound_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      routed_to TEXT,
      processing_status TEXT NOT NULL DEFAULT 'pending',
      completed_at TEXT,
      terminal_reason TEXT,
      continuity_candidate_reason TEXT
        CHECK (
          continuity_candidate_reason IS NULL OR
          continuity_candidate_reason IN ('crash_reclaim_no_terminal_outbound', 'runtime_fault_no_terminal_outbound')
        ),
      continuity_candidate_source TEXT
        CHECK (
          continuity_candidate_source IS NULL OR
          continuity_candidate_source IN ('pre_connect_recovery', 'runtime_fault_disarm')
        ),
      continuity_candidate_marked_at TEXT,
      failure_class TEXT,
      UNIQUE(message_id)
    );

    CREATE TRIGGER legacy_retain_source_inbound
      BEFORE DELETE ON inbound_events
      BEGIN
        SELECT RAISE(ABORT, 'legacy retain trigger');
      END;

    CREATE TRIGGER legacy_status_update_guard
      BEFORE UPDATE OF processing_status ON inbound_events
      WHEN NEW.processing_status = 'never_allowed'
      BEGIN
        SELECT RAISE(ABORT, 'legacy update guard');
      END;

    CREATE TABLE legacy_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_inbound_seq INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'open'
    );

    CREATE TRIGGER legacy_cross_table_guard
      BEFORE UPDATE OF state ON legacy_jobs
      WHEN NEW.state = 'done'
        AND NOT EXISTS (
          SELECT 1 FROM inbound_events i
          WHERE i.seq = NEW.source_inbound_seq
            AND i.processing_status IN ('complete', 'failed')
        )
      BEGIN
        SELECT RAISE(ABORT, 'legacy cross-table guard');
      END;
  `);
}

function insertInbound(
  raw: DatabaseSync,
  messageId: string,
  status: string,
): void {
  raw.prepare(`
    INSERT INTO inbound_events (
      message_id, conversation_key, chat_jid, processing_status, terminal_reason
    ) VALUES (?, 'conv', 'jid@s.whatsapp.net', ?, 'seed')
  `).run(messageId, status);
}

function tableSql(raw: DatabaseSync): string {
  return (
    raw
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inbound_events'",
      )
      .get() as { sql: string }
  ).sql;
}

function triggerNames(raw: DatabaseSync): string[] {
  return (
    raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'inbound_events' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function allStatuses(raw: DatabaseSync): string[] {
  return (
    raw
      .prepare(
        'SELECT processing_status AS status FROM inbound_events ORDER BY seq',
      )
      .all() as Array<{ status: string }>
  ).map((row) => row.status);
}

describe('migration 55 — inbound_events.processing_status CHECK constraint', () => {
  let raw: DatabaseSync;

  beforeEach(() => {
    raw = new DatabaseSync(':memory:');
    createLegacyInboundEvents(raw);
  });

  afterEach(() => {
    raw.close();
  });

  it('rebuilds with the CHECK, preserves every row verbatim, and recreates triggers', () => {
    for (const [index, status] of [
      'pending',
      'processing',
      'turn_done',
      'complete',
      'failed',
    ].entries()) {
      insertInbound(raw, `m-${index}`, status);
    }

    runMigration55(raw);

    expect(tableSql(raw)).toContain('CHECK (processing_status IN');
    expect(allStatuses(raw)).toEqual([
      'pending',
      'processing',
      'turn_done',
      'complete',
      'failed',
    ]);
    expect(triggerNames(raw)).toEqual([
      'legacy_retain_source_inbound',
      'legacy_status_update_guard',
    ]);
    // Cross-table trigger referencing inbound_events survives the rebuild.
    expect(
      raw
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'legacy_cross_table_guard'",
        )
        .get(),
    ).toBeTruthy();
    // Existing continuity CHECKs survive the rebuild.
    expect(tableSql(raw)).toContain('continuity_candidate_reason IS NULL OR');
  });

  it('cross-table trigger still enforces after the rebuild', () => {
    insertInbound(raw, 'm-pend', 'pending');
    raw.prepare("INSERT INTO legacy_jobs (source_inbound_seq, state) VALUES (1, 'open')").run();
    runMigration55(raw);

    // Source inbound is 'pending' (not terminal) — the guard must still abort.
    expect(() =>
      raw.prepare("UPDATE legacy_jobs SET state = 'done' WHERE id = 1").run(),
    ).toThrow(/legacy cross-table guard/);
    // Complete the inbound and the update passes.
    raw.prepare("UPDATE inbound_events SET processing_status = 'complete' WHERE message_id = 'm-pend'").run();
    expect(() =>
      raw.prepare("UPDATE legacy_jobs SET state = 'done' WHERE id = 1").run(),
    ).not.toThrow();
  });

  it('rejects out-of-union writes after the rebuild', () => {
    insertInbound(raw, 'm-ok', 'pending');
    runMigration55(raw);

    expect(() => insertInbound(raw, 'm-bogus', 'bogus_status')).toThrow();
    expect(() =>
      raw
        .prepare(
          "UPDATE inbound_events SET processing_status = 'bogus_status' WHERE message_id = 'm-ok'",
        )
        .run(),
    ).toThrow();
    expect(allStatuses(raw)).toEqual(['pending']);
  });

  it('aborts before mutating when a pre-existing row is out of union', () => {
    insertInbound(raw, 'm-good', 'pending');
    insertInbound(raw, 'm-bad', 'totally_unexpected');
    const before = tableSql(raw);

    expect(() => runMigration55(raw)).toThrow(/totally_unexpected/);

    // Fail-closed: no mutation, no remnant table, no CHECK, rows intact.
    expect(tableSql(raw)).toBe(before);
    expect(
      raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'inbound_events_v55'",
        )
        .all(),
    ).toEqual([]);
    expect(allStatuses(raw)).toEqual(['pending', 'totally_unexpected']);
    expect(triggerNames(raw)).toEqual([
      'legacy_retain_source_inbound',
      'legacy_status_update_guard',
    ]);
  });

  it('is idempotent on retry', () => {
    insertInbound(raw, 'm-1', 'complete');
    runMigration55(raw);
    const afterFirst = tableSql(raw);

    expect(() => runMigration55(raw)).not.toThrow();
    expect(tableSql(raw)).toBe(afterFirst);
    expect(allStatuses(raw)).toEqual(['complete']);
  });

  it('returns without error when inbound_events does not exist', () => {
    const empty = new DatabaseSync(':memory:');
    try {
      expect(() => runMigration55(empty)).not.toThrow();
    } finally {
      empty.close();
    }
  });

  it('full migration chain records v55 and enforces the constraint', () => {
    const db = new Database(':memory:');
    try {
      db.open();
      expect(CURRENT_SCHEMA_MIGRATION).toBe(55);
      expect(
        (
          db.raw
            .prepare('SELECT MAX(version) AS v FROM schema_migrations')
            .get() as { v: number }
        ).v,
      ).toBe(55);
      const sql = (
        db.raw
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inbound_events'",
          )
          .get() as { sql: string }
      ).sql;
      expect(sql).toContain('CHECK (processing_status IN');
      // All eight production triggers survive the rebuild.
      const triggers = (
        db.raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'inbound_events'",
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(triggers).toHaveLength(8);
      // Production cross-table triggers referencing inbound_events survive.
      const cross = (
        db.raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name != 'inbound_events' AND sql LIKE '%inbound_events%'",
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(cross.length).toBeGreaterThan(0);
      expect(cross).toContain('turn_recovery_completion_requires_terminal_source');
      expect(() =>
        db.raw
          .prepare(
            "INSERT INTO inbound_events (message_id, conversation_key, chat_jid, processing_status) VALUES ('x', 'k', 'j', 'nope')",
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
