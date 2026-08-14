import type { DatabaseSync } from 'node:sqlite';

/**
 * Migration 59 — capability-obligation post-merge-audit hotfix schema.
 *
 * 1. `capability_execution_reservations` (audit finding F1, Critical): a
 *    DURABLE pre-spawn execution reservation. The execute_capability handler
 *    INSERTs the (obligation_id, claim_epoch, attempt_number) reservation in
 *    its own committed transaction BEFORE spawning the external resolver; the
 *    UNIQUE constraint makes a second spawn attempt for the same claim/attempt
 *    a typed refusal instead of a duplicate external side effect. A
 *    process-local flag cannot provide this (it dies with the process; the
 *    defect was reproduced across handler calls). Append-only: a consumed
 *    reservation is execution evidence and must never be freed.
 *
 * 2. `capability_obligations.creation_reason` honesty rebuild (audit finding
 *    F6, minimal scope): the published migration-58 CHECK admitted only
 *    'typed_deferral_signal', but creation derives from input shape +
 *    tool-effect rows + harness class — no typed deferral is observed
 *    anywhere. Recording a reason the code never saw is an untruth. The CHECK
 *    is rebuilt to the honest vocabulary ('harness_capability_gap' |
 *    'reviewed_backfill:%'), existing rows are mapped
 *    typed_deferral_signal → harness_capability_gap during the copy, and the
 *    mid-term M1 work may ADD 'typed_deferral' when a real typed deferral
 *    signal exists. SQLite cannot alter a CHECK, so the table is rebuilt with
 *    the migration-56 pattern: capture triggers + transitive dependents from
 *    sqlite_master, SAVEPOINT, deferred FKs, double-copy through a _v59
 *    table, recreate captured objects verbatim.
 *
 * Fail-closed properties (mirrors migration 56):
 * - Pre-flight: any creation_reason outside the known old/new vocabulary
 *   aborts BEFORE mutation, naming the offending values.
 * - Atomic: SAVEPOINT-wrapped; a mid-rebuild error rolls back to the
 *   untouched table.
 * - Idempotent: a completed rebuild is detected via the new CHECK text in the
 *   table SQL; the reservation table is CREATE IF NOT EXISTS.
 */
export function runMigration59(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS capability_execution_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      obligation_id INTEGER NOT NULL,
      claim_epoch INTEGER NOT NULL CHECK (claim_epoch >= 1),
      attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
      tool_use_id TEXT NOT NULL,
      reserved_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (obligation_id, claim_epoch, attempt_number)
    );

    CREATE TRIGGER IF NOT EXISTS capability_execution_reservations_no_update
    BEFORE UPDATE ON capability_execution_reservations
    BEGIN
      SELECT RAISE(ABORT, 'capability_execution_reservations: append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS capability_execution_reservations_no_delete
    BEFORE DELETE ON capability_execution_reservations
    BEGIN
      SELECT RAISE(ABORT, 'capability_execution_reservations: append-only');
    END;
  `);

  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'capability_obligations'")
    .get() as { sql: string } | undefined;
  if (!table) return; // legacy/partial fixture without the migration-58 tables: nothing to rebuild
  if (table.sql.includes("'harness_capability_gap'")) return; // rebuild already completed

  const distinct = db
    .prepare('SELECT DISTINCT creation_reason AS reason FROM capability_obligations')
    .all() as Array<{ reason: unknown }>;
  const invalid = distinct
    .map((row) => row.reason)
    .filter(
      (reason) =>
        typeof reason !== 'string'
        || !(
          reason === 'typed_deferral_signal'
          || reason === 'harness_capability_gap'
          || reason.startsWith('reviewed_backfill:')
        ),
    );
  if (invalid.length > 0) {
    throw new Error(
      'migration 59 abort: capability_obligations.creation_reason holds value(s)'
        + ` outside the known vocabulary: ${invalid.map(String).join(', ')}`,
    );
  }

  const triggerSql = (
    db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'capability_obligations' ORDER BY name",
      )
      .all() as Array<{ sql: string }>
  ).map((row) => row.sql);
  const indexSql = (
    db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'capability_obligations' AND sql IS NOT NULL ORDER BY name",
      )
      .all() as Array<{ sql: string }>
  ).map((row) => row.sql);

  // Transitive dependents (triggers/views on OTHER tables whose bodies name
  // capability_obligations, or name another dependent) would dangle across the
  // DROP — capture, drop in reverse dependency order, recreate in order.
  const allDependents = db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE type IN ('trigger', 'view') AND tbl_name != 'capability_obligations'",
    )
    .all() as Array<{ type: 'trigger' | 'view'; name: string; sql: string }>;
  const included = new Set<string>();
  for (const object of allDependents) {
    if (object.sql.includes('capability_obligations')) included.add(object.name);
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
  for (const object of dependents) {
    if (!placed.has(object.name)) recreateOrder.push(object);
  }

  // The rebuilt table is byte-identical to the live DDL except the
  // creation_reason CHECK. Deriving it textually from sqlite_master (instead
  // of restating 70 lines of DDL) guarantees the rest of the shape cannot
  // silently diverge from what migration 58 actually created.
  const oldCheck = `creation_reason = 'typed_deferral_signal'
        OR creation_reason LIKE 'reviewed_backfill:%'`;
  const newCheck = `creation_reason = 'harness_capability_gap'
        OR creation_reason LIKE 'reviewed_backfill:%'`;
  if (!table.sql.includes(oldCheck)) {
    throw new Error(
      'migration 59 abort: capability_obligations DDL does not contain the expected migration-58 creation_reason CHECK — refusing a blind rebuild',
    );
  }
  const rebuiltDdl = table.sql.replace(oldCheck, newCheck);
  const tempDdl = rebuiltDdl.replace(
    /CREATE TABLE (IF NOT EXISTS )?"?capability_obligations"?/,
    'CREATE TABLE capability_obligations_v59',
  );
  const columns = (
    db.prepare('PRAGMA table_info(capability_obligations)').all() as Array<{ name: string }>
  ).map((c) => c.name);
  const columnList = columns.join(', ');
  const selectList = columns
    .map((c) =>
      c === 'creation_reason'
        ? "CASE WHEN creation_reason = 'typed_deferral_signal' THEN 'harness_capability_gap' ELSE creation_reason END AS creation_reason"
        : c,
    )
    .join(', ');

  db.prepare('PRAGMA defer_foreign_keys = ON').run();
  db.exec('SAVEPOINT migration_59');
  try {
    for (const object of [...recreateOrder].reverse()) {
      db.exec(`DROP ${object.type === 'view' ? 'VIEW' : 'TRIGGER'} IF EXISTS ${object.name}`);
    }
    db.exec(tempDdl);
    db.exec(`INSERT INTO capability_obligations_v59 (${columnList}) SELECT ${selectList} FROM capability_obligations`);
    db.exec('DROP TABLE capability_obligations');
    db.exec(rebuiltDdl);
    db.exec(`INSERT INTO capability_obligations (${columnList}) SELECT ${columnList} FROM capability_obligations_v59`);
    db.exec('DROP TABLE capability_obligations_v59');
    for (const sql of triggerSql) db.exec(sql);
    for (const sql of indexSql) db.exec(sql);
    for (const object of recreateOrder) db.exec(object.sql);
    db.exec('RELEASE migration_59');
  } catch (error) {
    db.exec('ROLLBACK TO migration_59');
    db.exec('RELEASE migration_59');
    throw error;
  }
}
