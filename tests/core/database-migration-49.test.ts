import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, CURRENT_SCHEMA_MIGRATION } from '../../src/core/database.ts';
import { runMigration49 } from '../../src/core/database-migration-49.ts';

describe('migration 49 memory consolidation receipts', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => db.close());

  it('installs the bounded content-free receipt table and indexes', () => {
    expect(CURRENT_SCHEMA_MIGRATION).toBe(49);
    expect(db.raw.prepare(
      'SELECT version FROM schema_migrations WHERE version = 49',
    ).get()).toEqual({ version: 49 });

    const columns = db.raw.prepare(
      "PRAGMA table_info('memory_consolidation_runs')",
    ).all() as Array<{ name: string }>;
    const names = columns.map(({ name }) => name);
    expect(names).toEqual([
      'run_id',
      'schema_version',
      'source',
      'mode',
      'status',
      'stage',
      'failure_code',
      'retryable',
      'evidence_coverage',
      'attempted_at',
      'last_progress_at',
      'last_skipped_at',
      'lease_expires_at',
      'completed_at',
      'success_at',
      'records_observed',
      'clusters_attempted',
      'clusters_completed',
      'would_promote',
      'write_attempted',
      'write_confirmed',
      'discarded',
      'failed',
      'skipped',
      'overlap_skipped',
    ]);
    expect(names).not.toEqual(expect.arrayContaining([
      'claim',
      'text',
      'source_id',
      'chat_jid',
      'sender_jid',
      'error',
      'hash',
      'model_output',
    ]));

    for (const index of [
      'idx_memory_consolidation_runs_status_attempt',
      'idx_memory_consolidation_runs_completed',
    ]) {
      expect(db.raw.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?
      `).get(index)).toEqual({ name: index });
    }
    expect(db.raw.prepare('PRAGMA quick_check').get()).toEqual({
      quick_check: 'ok',
    });
    expect(db.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('enforces enums, terminal timestamps, and nonnegative integer counters', () => {
    const insert = db.raw.prepare(`
      INSERT INTO memory_consolidation_runs (
        run_id, source, mode, status, stage, failure_code, retryable,
        evidence_coverage, attempted_at, last_progress_at, lease_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    expect(() => insert.run(
      null,
      'manual',
      'live',
      'running',
      'scheduled',
      'none',
      0,
      'not_observed',
      1,
      1,
      2,
    )).toThrow();
    expect(() => insert.run(
      'a'.repeat(32),
      'unknown',
      'live',
      'running',
      'scheduled',
      'none',
      0,
      'not_observed',
      1,
      1,
      2,
    )).toThrow();
    expect(() => insert.run(
      'b'.repeat(32),
      'manual',
      'live',
      'completed',
      'finalize',
      'none',
      0,
      'provider_response',
      1,
      1,
      2,
    )).toThrow();

    insert.run(
      'c'.repeat(32),
      'manual',
      'live',
      'running',
      'scheduled',
      'none',
      0,
      'not_observed',
      1,
      1,
      2,
    );
    expect(() => db.raw.prepare(`
      UPDATE memory_consolidation_runs SET failed = -1
      WHERE run_id = ?
    `).run('c'.repeat(32))).toThrow();
  });

  it('is idempotent when invoked directly', () => {
    const raw = new DatabaseSync(':memory:');
    try {
      runMigration49(raw);
      runMigration49(raw);
      expect(raw.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name = 'memory_consolidation_runs'
      `).get()).toEqual({ count: 1 });
    } finally {
      raw.close();
    }
  });

  it('requires success_at exactly for successful terminal statuses', () => {
    expect(() => db.raw.prepare(`
      INSERT INTO memory_consolidation_runs (
        run_id, source, mode, status, stage, attempted_at, last_progress_at,
        completed_at
      ) VALUES (?, 'manual', 'live', 'completed', 'finalize', 1, 1, 2)
    `).run('d'.repeat(32))).toThrow();

    expect(() => db.raw.prepare(`
      INSERT INTO memory_consolidation_runs (
        run_id, source, mode, status, stage, attempted_at, last_progress_at,
        completed_at, success_at
      ) VALUES (?, 'manual', 'live', 'failed', 'finalize', 1, 1, 2, 2)
    `).run('e'.repeat(32))).toThrow();
  });
});
