// Migration 59 — fact export queue state machine + lease durability (#2567 slice 1).
//
// The migration-20 table had a free-form status column, no lease, no attempt
// accounting, and no failure metadata: claimers were unfenced SELECTs and a
// crash between remote write and local acknowledgement was unobservable. This
// rebuild (outbound_sends/v26 pattern) enforces the explicit state machine in
// schema, adds lease/attempt/failure/acknowledgement columns, and assigns a
// salted opaque fact_uid to every row so wire and observability surfaces never
// carry the identity-bearing legacy fact_id.
//
// Legacy disposition: pending/exported/quarantined map one-to-one; any other
// historical status becomes 'legacy_unclassified' — an explicit terminal
// parking state, never inferred from untyped content and never re-leased.
import type { DatabaseSync } from 'node:sqlite';
import { deriveFactUid, FACT_UID_SALT_KEY, newFactUidSalt } from './fact-uid.ts';

export function runMigration59(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fact_export_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  db.prepare(
    `INSERT OR IGNORE INTO fact_export_meta (key, value) VALUES (?, ?)`,
  ).run(FACT_UID_SALT_KEY, newFactUidSalt());
  const salt = (db
    .prepare('SELECT value FROM fact_export_meta WHERE key = ?')
    .get(FACT_UID_SALT_KEY) as { value: string }).value;

  const cols = (db.prepare("PRAGMA table_info('fact_export_queue')").all() as Array<{ name: string }>)
    .map(c => c.name);
  if (cols.includes('state') && cols.includes('fact_uid')) {
    return; // Already rebuilt — idempotency guard.
  }
  // Minimal legacy snapshots (migration-safety harness) may lack the table
  // entirely; there is nothing to migrate, so create the new shape directly.
  const legacyTableExists = cols.length > 0;

  db.exec(`
    CREATE TABLE fact_export_queue_v59 (
      id               INTEGER PRIMARY KEY,
      fact_uid         TEXT UNIQUE NOT NULL,
      fact_id          TEXT UNIQUE NOT NULL,
      chat_jid         TEXT NOT NULL,
      sender_jid       TEXT,
      namespace        TEXT NOT NULL DEFAULT 'whatsapp-facts',
      payload_json     TEXT NOT NULL,
      state            TEXT NOT NULL DEFAULT 'pending'
                       CHECK (state IN ('pending','leased','retry_wait','exported',
                                        'quarantined','retry_exhausted','legacy_unclassified')),
      lease_owner      TEXT,
      lease_expires_at INTEGER,
      attempt_count    INTEGER NOT NULL DEFAULT 0,
      failure_code     TEXT,
      failure_stage    TEXT,
      next_attempt_at  INTEGER,
      remote_record_id TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      exported_at      TEXT,
      acked_at         INTEGER
    );
  `);

  if (legacyTableExists) {
    const legacyRows = db
      .prepare('SELECT id, fact_id, status FROM fact_export_queue ORDER BY id')
      .all() as Array<{ id: number; fact_id: string; status: string }>;
    const copyRow = db.prepare(`
      INSERT INTO fact_export_queue_v59
        (id, fact_uid, fact_id, chat_jid, sender_jid, namespace, payload_json, state, created_at, exported_at)
      SELECT id, ?, fact_id, chat_jid, sender_jid, namespace, payload_json, ?, created_at, exported_at
        FROM fact_export_queue WHERE id = ?
    `);
    for (const row of legacyRows) {
      const state = row.status === 'pending' || row.status === 'exported' || row.status === 'quarantined'
        ? row.status
        : 'legacy_unclassified';
      copyRow.run(deriveFactUid(salt, row.fact_id), state, row.id);
    }
    db.exec('DROP TABLE fact_export_queue;');
  }

  db.exec(`
    ALTER TABLE fact_export_queue_v59 RENAME TO fact_export_queue;

    CREATE INDEX IF NOT EXISTS idx_fact_export_queue_leasable
      ON fact_export_queue(state, next_attempt_at, id)
      WHERE state IN ('pending', 'retry_wait');
    CREATE INDEX IF NOT EXISTS idx_fact_export_queue_lease_expiry
      ON fact_export_queue(state, lease_expires_at)
      WHERE state = 'leased';
  `);
}
