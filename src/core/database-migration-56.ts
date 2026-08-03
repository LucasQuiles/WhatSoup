import type { DatabaseSync } from 'node:sqlite';
import { INBOUND_STATUSES } from './inbound-status.ts';

/**
 * Add a CHECK constraint closing `inbound_events.processing_status` to the
 * canonical InboundStatus union (#2250). Before this migration the column
 * accepted any string, so a malformed value could land silently and every
 * reader (including `getInboundStatus`) saw a widened `string` type.
 *
 * SQLite cannot add a CHECK via ALTER TABLE, so the table is rebuilt:
 * create `_v56` with the constraint, copy every row verbatim, drop the old
 * table, rename, then recreate the triggers captured before the drop.
 *
 * Fail-closed properties (adversarial review, #2250):
 * - Pre-flight scan: any out-of-union value aborts BEFORE any mutation, with
 *   the offending values named in the error. The DB stays at v54 and the
 *   migration retries on next boot.
 * - Atomicity: the rebuild runs inside a SAVEPOINT, which nests within the
 *   framework's BEGIN IMMEDIATE...COMMIT wrapper (database.ts open()) and
 *   also starts a standalone transaction when invoked directly. A
 *   mid-rebuild crash or error rolls back to the untouched old table, and
 *   the write lock held by the outer transaction prevents any
 *   concurrent-writer interleave during the copy.
 * - FK-safe: `inbound_disposition_links` and
 *   `operator_catchup_closure_witnesses` hold `REFERENCES
 *   inbound_events(seq) ON DELETE RESTRICT`. `PRAGMA defer_foreign_keys = ON`
 *   is set before the DROP, deferring FK enforcement to COMMIT. By then,
 *   the new `inbound_events` carries the same seq values (verbatim copy),
 *   so every child-table FK reference is satisfied.
 * - Idempotent: a completed rebuild is detected via the constraint text in
 *   the table SQL and skipped on retry.
 */
export function runMigration56(db: DatabaseSync): void {
  const table = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inbound_events'",
    )
    .get() as { sql: string } | undefined;
  if (!table) return;
  if (table.sql.includes('CHECK (processing_status IN')) return;

  const distinct = db
    .prepare('SELECT DISTINCT processing_status AS status FROM inbound_events')
    .all() as Array<{ status: unknown }>;
  const invalid = distinct
    .map((row) => row.status)
    .filter(
      (status) =>
        typeof status !== 'string'
        || !(INBOUND_STATUSES as readonly string[]).includes(status),
    );
  if (invalid.length > 0) {
    throw new Error(
      'migration 56 abort: inbound_events.processing_status holds value(s)'
        + ` outside the canonical InboundStatus union: ${invalid.map(String).join(', ')}`,
    );
  }

  const triggerSql = (
    db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'inbound_events' ORDER BY name",
      )
      .all() as Array<{ sql: string }>
  ).map((row) => row.sql);

  // Dependent schema objects whose bodies reference inbound_events — or
  // reference another dependent object (view-on-view chains such as
  // operator_catchup_delivery_proofs → operator_catchup_delivery_proof_
  // candidates) — would dangle during the DROP and break schema reload for
  // every subsequent statement. The transitive closure is computed by name
  // reference, dropped in reverse dependency order, and recreated verbatim
  // in dependency order after the rename.
  const allDependents = db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE type IN ('trigger', 'view') AND tbl_name != 'inbound_events'",
    )
    .all() as Array<{ type: 'trigger' | 'view'; name: string; sql: string }>;

  const included = new Set<string>();
  for (const object of allDependents) {
    if (object.sql.includes('inbound_events')) included.add(object.name);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const object of allDependents) {
      if (included.has(object.name)) continue;
      for (const name of included) {
        if (object.sql.includes(name)) {
          included.add(object.name);
          grew = true;
          break;
        }
      }
    }
  }

  const dependents = allDependents.filter((object) => included.has(object.name));
  const recreateOrder: typeof dependents = [];
  const placed = new Set<string>();
  let progressed = true;
  while (recreateOrder.length < dependents.length && progressed) {
    progressed = false;
    for (const object of dependents) {
      if (placed.has(object.name)) continue;
      const references = [...included].filter(
        (name) => name !== object.name && object.sql.includes(name),
      );
      if (references.every((name) => placed.has(name))) {
        recreateOrder.push(object);
        placed.add(object.name);
        progressed = true;
      }
    }
  }
  // Cyclic references cannot occur in SQLite views/triggers; anything left
  // over failed the name-match heuristic and is appended verbatim.
  for (const object of dependents) {
    if (!placed.has(object.name)) recreateOrder.push(object);
  }

  const statuses = INBOUND_STATUSES.map((status) => `'${status}'`).join(', ');

  // Defer FK enforcement so the DROP TABLE inbound_events succeeds
  // while FK-child tables (inbound_disposition_links,
  // operator_catchup_closure_witnesses) hold REFERENCES.
  // Must use prepare().run() not exec() for reliable PRAGMA effect.
  db.prepare('PRAGMA defer_foreign_keys = ON').run();
  db.exec('SAVEPOINT migration_56');
  try {
    for (const object of [...recreateOrder].reverse()) {
      db.exec(`DROP ${object.type === 'view' ? 'VIEW' : 'TRIGGER'} IF EXISTS ${object.name}`);
    }
    db.exec(`
      CREATE TABLE inbound_events_v56 (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        received_at TEXT NOT NULL DEFAULT (datetime('now')),
        routed_to TEXT,
        processing_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (processing_status IN (${statuses})),
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

      INSERT INTO inbound_events_v56 (
        seq, message_id, conversation_key, chat_jid, received_at, routed_to,
        processing_status, completed_at, terminal_reason,
        continuity_candidate_reason, continuity_candidate_source,
        continuity_candidate_marked_at, failure_class
      )
      SELECT
        seq, message_id, conversation_key, chat_jid, received_at, routed_to,
        processing_status, completed_at, terminal_reason,
        continuity_candidate_reason, continuity_candidate_source,
        continuity_candidate_marked_at, failure_class
      FROM inbound_events;

      DROP TABLE inbound_events;
      ALTER TABLE inbound_events_v56 RENAME TO inbound_events;
    `);
    for (const sql of triggerSql) {
      db.exec(sql);
    }
    for (const object of recreateOrder) {
      db.exec(object.sql);
    }
    db.exec('RELEASE migration_56');
  } catch (error) {
    db.exec('ROLLBACK TO migration_56');
    db.exec('RELEASE migration_56');
    throw error;
  }
}
