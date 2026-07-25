import type { DatabaseSync } from 'node:sqlite';

const REQUIRED_TABLES = ['inbound_events', 'turn_recovery_jobs'] as const;
const REQUIRED_COLUMNS = new Map([
  ['inbound_events', ['seq', 'message_id', 'received_at']],
  ['turn_recovery_jobs', ['source_inbound_seq']],
] as const);
const TRIGGERS = new Map([
  ['turn_recovery_source_inbound_receipt_immutable', `
    CREATE TRIGGER turn_recovery_source_inbound_receipt_immutable
    BEFORE UPDATE OF received_at ON inbound_events
    WHEN EXISTS (
      SELECT 1 FROM turn_recovery_jobs j WHERE j.source_inbound_seq = OLD.seq
    ) AND NEW.received_at IS NOT OLD.received_at
    BEGIN
      SELECT RAISE(ABORT, 'turn recovery source inbound receipt is immutable');
    END
  `],
  ['turn_recovery_source_inbound_replacement_blocked', `
    CREATE TRIGGER turn_recovery_source_inbound_replacement_blocked
    BEFORE INSERT ON inbound_events
    WHEN EXISTS (
      SELECT 1
      FROM inbound_events existing
      JOIN turn_recovery_jobs j ON j.source_inbound_seq = existing.seq
      WHERE existing.seq = NEW.seq
        OR existing.message_id = NEW.message_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'turn recovery source inbound replacement is blocked');
    END
  `],
] as const);

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().replace(/;$/, '');
}

function assertCanonicalTrigger(db: DatabaseSync, name: string, sql: string): boolean {
  const existing = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?
  `).get(name) as { sql: string } | undefined;
  if (!existing) return false;
  if (normalizeSql(existing.sql) !== normalizeSql(sql)) {
    throw new Error(`migration 47 found drifted trigger: ${name}`);
  }
  return true;
}

/**
 * Freeze the journal receipt once an inbound event is linked to a recovery job,
 * including SQLite replacement inserts whose implicit delete skips DELETE
 * triggers when recursive_triggers is disabled.
 *
 * Migration 40 already protects the source identity. These separate triggers
 * preserve that shipped trigger byte-for-byte while closing the chronology
 * provenance gap for received_at.
 */
export function runMigration47(db: DatabaseSync): void {
  const missingTables = REQUIRED_TABLES.filter((name) => !db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
  if (missingTables.length > 0) {
    throw new Error(`migration 47 missing required tables: ${missingTables.join(', ')}`);
  }

  for (const [table, required] of REQUIRED_COLUMNS) {
    const columns = new Set((db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{
      name: string;
    }>).map(({ name }) => name));
    const missing = required.filter((name) => !columns.has(name));
    if (missing.length > 0) {
      throw new Error(`migration 47 ${table} missing required columns: ${missing.join(', ')}`);
    }
  }

  const missing: string[] = [];
  for (const [name, sql] of TRIGGERS) {
    if (!assertCanonicalTrigger(db, name, sql)) missing.push(sql);
  }
  if (missing.length === 0) return;

  db.exec(missing.map((sql) => `${sql};`).join('\n'));
  for (const [name, sql] of TRIGGERS) {
    assertCanonicalTrigger(db, name, sql);
  }
}
