import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigration52 } from '../../src/core/database-migration-52.ts';
import { CURRENT_SCHEMA_MIGRATION, Database } from '../../src/core/database.ts';

function createLegacyEnrichmentRuns(raw: DatabaseSync): void {
  raw.exec(`
    CREATE TABLE enrichment_runs (
      run_id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      messages_processed INTEGER DEFAULT 0,
      facts_extracted INTEGER DEFAULT 0,
      facts_upserted INTEGER DEFAULT 0,
      error TEXT
    )
  `);
}

describe('migration 52 enrichment-cycle receipts', () => {
  let raw: DatabaseSync;

  beforeEach(() => {
    raw = new DatabaseSync(':memory:');
    createLegacyEnrichmentRuns(raw);
  });

  afterEach(() => {
    raw.close();
  });

  it('completes a partially applied additive migration without losing the legacy row', () => {
    raw.prepare(`
      INSERT INTO enrichment_runs (
        started_at, completed_at, messages_processed, facts_extracted, facts_upserted, error
      ) VALUES ('2026-07-30 00:00:00', '2026-07-30 00:00:01', 2, 3, 4, 'legacy prose')
    `).run();
    raw.exec('ALTER TABLE enrichment_runs ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1)');

    runMigration52(raw);

    const columns = raw
      .prepare("PRAGMA table_info('enrichment_runs')")
      .all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'schema_version',
      'source',
      'status',
      'failure_code',
      'stage',
      'retryable',
      'evidence_coverage',
      'success_at',
      'messages_selected',
      'messages_succeeded',
      'messages_deferred',
      'messages_terminal',
      'facts_queued',
    ]));
    expect(raw.prepare(`
      SELECT schema_version, source, status, failure_code, stage, retryable,
             evidence_coverage, success_at, messages_selected, messages_succeeded,
             messages_deferred, messages_terminal, facts_queued, error
      FROM enrichment_runs
    `).get()).toEqual({
      schema_version: 1,
      source: 'legacy',
      status: 'legacy_unclassified',
      failure_code: 'legacy_unclassified',
      stage: 'none',
      retryable: 0,
      evidence_coverage: 'legacy_unclassified',
      success_at: null,
      messages_selected: 0,
      messages_succeeded: 0,
      messages_deferred: 0,
      messages_terminal: 0,
      facts_queued: 0,
      error: 'legacy prose',
    });
  });

  it('is registered as the current schema migration', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      expect(CURRENT_SCHEMA_MIGRATION).toBe(52);
      expect(db.raw.prepare(
        'SELECT version FROM schema_migrations WHERE version = 52',
      ).get()).toEqual({ version: 52 });
    } finally {
      db.close();
    }
  });

  it('rejects invalid receipt vocabulary and negative aggregate counters', () => {
    runMigration52(raw);

    expect(() => raw.prepare(`
      INSERT INTO enrichment_runs (started_at, source)
      VALUES ('2026-07-30T00:00:00.000Z', 'untrusted')
    `).run()).toThrow();
    expect(() => raw.prepare(`
      INSERT INTO enrichment_runs (started_at, status)
      VALUES ('2026-07-30T00:00:00.000Z', 'unclassified')
    `).run()).toThrow();
    expect(() => raw.prepare(`
      INSERT INTO enrichment_runs (
        started_at, source, status, failure_code, stage, evidence_coverage,
        success_at, messages_selected
      ) VALUES (
        '2026-07-30T00:00:00.000Z', 'online', 'completed', 'none', 'none', 'typed',
        '2026-07-30T00:00:01.000Z', -1
      )
    `).run()).toThrow();
  });

  it('adds the online receipt reader indexes idempotently', () => {
    runMigration52(raw);
    runMigration52(raw);

    const indexes = raw.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'enrichment_runs'
    `).all() as Array<{ name: string }>;

    expect(indexes.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'idx_enrichment_runs_source_run_id',
      'idx_enrichment_runs_online_success_run_id',
    ]));
  });
});
