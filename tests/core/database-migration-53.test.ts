import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigration53 } from '../../src/core/database-migration-53.ts';
import { CURRENT_SCHEMA_MIGRATION, Database } from '../../src/core/database.ts';

describe('migration 53 outbound quarantine dispositions', () => {
  let db: Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('adds bounded quarantine metadata without rewriting the failure-evidence column', () => {
    db = new Database(':memory:');
    db.open();

    expect(CURRENT_SCHEMA_MIGRATION).toBe(56);
    const columns = db.raw.prepare("PRAGMA table_info('outbound_ops')").all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'error',
      'quarantine_disposition',
      'quarantine_evidence_coverage',
      'quarantine_evidence_sha256',
      'quarantined_at',
    ]));
    expect(db.raw.prepare(
      'SELECT version FROM schema_migrations WHERE version = 53',
    ).get()).toEqual({ version: 53 });
    expect(db.raw.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'outbound_quarantine_retirements'",
    ).get()).toEqual({ name: 'outbound_quarantine_retirements' });
  });

  it('upgrades a v52-style quarantine conservatively and remains idempotent', () => {
    const raw = new DatabaseSync(':memory:');
    try {
      raw.exec(`
        CREATE TABLE outbound_ops (
          id INTEGER PRIMARY KEY,
          status TEXT NOT NULL,
          error TEXT
        );
        INSERT INTO outbound_ops (id, status, error)
        VALUES (42, 'quarantined', 'legacy opaque failure evidence');
      `);

      runMigration53(raw);
      expect(raw.prepare(`
        SELECT error, quarantine_disposition, quarantine_evidence_coverage,
               quarantine_evidence_sha256, quarantined_at
          FROM outbound_ops
         WHERE id = 42
      `).get()).toEqual({
        error: 'legacy opaque failure evidence',
        quarantine_disposition: 'legacy_unclassified',
        quarantine_evidence_coverage: 'legacy_unclassified',
        quarantine_evidence_sha256: null,
        quarantined_at: null,
      });

      runMigration53(raw);
      const columns = raw.prepare("PRAGMA table_info('outbound_ops')").all() as Array<{ name: string }>;
      expect(columns.filter(({ name }) => name === 'quarantine_disposition')).toHaveLength(1);
      expect(raw.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'outbound_quarantine_retirements'",
      ).get()).toEqual({ name: 'outbound_quarantine_retirements' });
    } finally {
      raw.close();
    }
  });

  it('accepts only policy-matched receipts bound to immutable canonical evidence', () => {
    const raw = new DatabaseSync(':memory:');
    try {
      raw.exec(`
        CREATE TABLE outbound_ops (
          id INTEGER PRIMARY KEY,
          status TEXT NOT NULL,
          error TEXT
        );
        INSERT INTO outbound_ops (id, status) VALUES (1, 'failed_permanent');
      `);
      runMigration53(raw);

      const insert = raw.prepare(`
        INSERT INTO outbound_quarantine_retirements (
          outbound_op_id, quarantine_disposition, acknowledgement, evidence_sha256
        ) VALUES (?, ?, ?, ?)
      `);
      expect(() => insert.run(
        1,
        'delivery_ambiguous_unsafe',
        'none',
        'a'.repeat(64),
      )).toThrow();
      expect(() => insert.run(
        1,
        'delivery_ambiguous_unsafe',
        'delivery-risk-reviewed',
        'A'.repeat(64),
      )).toThrow();
      expect(() => insert.run(
        1,
        'delivery_ambiguous_unsafe',
        'delivery-risk-reviewed',
        'a'.repeat(64),
      )).toThrow();
      raw.prepare(`
        UPDATE outbound_ops
           SET quarantine_evidence_sha256 = ?
         WHERE id = 1
      `).run('a'.repeat(64));
      expect(() => insert.run(
        1,
        'delivery_ambiguous_unsafe',
        'delivery-risk-reviewed',
        'a'.repeat(64),
      )).not.toThrow();
      expect(() => raw.prepare(`
        UPDATE outbound_ops
           SET quarantine_evidence_sha256 = ?
         WHERE id = 1
      `).run('b'.repeat(64))).toThrow();
    } finally {
      raw.close();
    }
  });
});
