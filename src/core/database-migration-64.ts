// Migration 64 — continuity-candidate consumer stamp.
//
// The continuity-candidate marks (continuity_candidate_reason/source/marked_at,
// migrations 34/56) are durable evidence that an admitted turn was dropped with
// the reply guarantee still armed and NO terminal outbound. Until now they were
// write-only: no reader, no consumer, no operator surface. This column lets the
// consumer stamp a row once it has surfaced it (aggregate alert + operator
// count), so a marked row is surfaced once and never re-alerted forever.
//
// Additive, nullable, no CHECK, no default, no backfill: pre-consumer rows stay
// consumed_at=NULL (unconsumed) and are picked up on the next consumer pass.
import type { DatabaseSync } from 'node:sqlite';

export function runMigration64(db: DatabaseSync): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inbound_events'")
    .get() as { name: string } | undefined;
  if (!table) return;

  const names = new Set(
    (db.prepare("PRAGMA table_info('inbound_events')").all() as Array<{ name: string }>)
      .map((c) => c.name),
  );

  if (!names.has('continuity_candidate_consumed_at')) {
    db.exec('ALTER TABLE inbound_events ADD COLUMN continuity_candidate_consumed_at TEXT');
  }
}
