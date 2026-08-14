import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigration59 } from '../../src/core/database-migration-59.ts';

// Pre-58 shape: migration 20 created fact_export_queue with a free-form
// status column and no lease/attempt/failure fields.
const MIGRATION_20_SHAPE = `
CREATE TABLE IF NOT EXISTS fact_export_queue (
  id INTEGER PRIMARY KEY,
  fact_id TEXT UNIQUE NOT NULL,
  chat_jid TEXT NOT NULL,
  sender_jid TEXT,
  namespace TEXT NOT NULL DEFAULT 'whatsapp-facts',
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  exported_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_fact_export_queue_pending ON fact_export_queue(status, id)
  WHERE status = 'pending';
`;

describe('migration 59 fact export queue state machine', () => {
  let raw: DatabaseSync;

  beforeEach(() => {
    raw = new DatabaseSync(':memory:');
    raw.exec(MIGRATION_20_SHAPE);
  });

  afterEach(() => raw.close());

  function seedLegacy(factId: string, status: string): void {
    raw.prepare(
      `INSERT INTO fact_export_queue (fact_id, chat_jid, sender_jid, namespace, payload_json, status)
       VALUES (?, 'legacy-chat@g.us', NULL, 'whatsapp-facts', '{}', ?)`,
    ).run(factId, status);
  }

  it('rebuilds the table with the explicit state machine and durability columns', () => {
    runMigration59(raw);
    const cols = (raw.prepare("PRAGMA table_info('fact_export_queue')").all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'fact_uid', 'fact_id', 'state', 'lease_owner', 'lease_expires_at',
      'attempt_count', 'failure_code', 'failure_stage', 'next_attempt_at',
      'remote_record_id', 'acked_at',
    ]));
    expect(cols).not.toContain('status');

    // The state machine is schema-enforced.
    expect(() => raw.prepare(
      `INSERT INTO fact_export_queue (fact_uid, fact_id, chat_jid, payload_json, state)
       VALUES ('fe_x', 'x', 'c@g.us', '{}', 'sprinting')`,
    ).run()).toThrow(/CHECK/);
  });

  it('maps known legacy statuses one-to-one and quarantines nothing silently', () => {
    seedLegacy('f-pending', 'pending');
    seedLegacy('f-exported', 'exported');
    seedLegacy('f-quarantined', 'quarantined');
    runMigration59(raw);
    const states = Object.fromEntries(
      (raw.prepare('SELECT fact_id, state FROM fact_export_queue').all() as Array<{ fact_id: string; state: string }>)
        .map(r => [r.fact_id, r.state]),
    );
    expect(states).toEqual({
      'f-pending': 'pending',
      'f-exported': 'exported',
      'f-quarantined': 'quarantined',
    });
  });

  it('gives unknown legacy statuses the explicit legacy_unclassified disposition', () => {
    seedLegacy('f-weird', 'in-flight');
    seedLegacy('f-empty', '');
    runMigration59(raw);
    const rows = raw
      .prepare("SELECT fact_id, state FROM fact_export_queue ORDER BY fact_id")
      .all() as Array<{ fact_id: string; state: string }>;
    expect(rows).toEqual([
      { fact_id: 'f-empty', state: 'legacy_unclassified' },
      { fact_id: 'f-weird', state: 'legacy_unclassified' },
    ]);
  });

  it('backfills a salted opaque fact_uid for every legacy row', () => {
    seedLegacy('legacy-chat@g.us:SENDER@s.whatsapp.net:abc123', 'pending');
    seedLegacy('other-chat@g.us:group:def456', 'exported');
    runMigration59(raw);
    const rows = raw
      .prepare('SELECT fact_id, fact_uid FROM fact_export_queue')
      .all() as Array<{ fact_id: string; fact_uid: string }>;
    for (const row of rows) {
      expect(row.fact_uid).toMatch(/^fe_[0-9a-f]{24}$/);
      expect(row.fact_uid).not.toContain('g.us');
      expect(row.fact_uid).not.toContain('abc123');
    }
    expect(new Set(rows.map(r => r.fact_uid)).size).toBe(2);

    // Salt is persisted so uid derivation is stable within this database.
    const salt = raw
      .prepare("SELECT value FROM fact_export_meta WHERE key = 'fact_uid_salt'")
      .get() as { value: string } | undefined;
    expect(salt?.value).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is idempotent', () => {
    seedLegacy('f-pending', 'pending');
    runMigration59(raw);
    const salt1 = (raw.prepare("SELECT value FROM fact_export_meta WHERE key = 'fact_uid_salt'").get() as { value: string }).value;
    runMigration59(raw);
    const salt2 = (raw.prepare("SELECT value FROM fact_export_meta WHERE key = 'fact_uid_salt'").get() as { value: string }).value;
    expect(salt2).toBe(salt1);
    const count = (raw.prepare('SELECT COUNT(*) AS n FROM fact_export_queue').get() as { n: number }).n;
    expect(count).toBe(1);
  });
});
