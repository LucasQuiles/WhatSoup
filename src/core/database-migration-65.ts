// Migration 65 — tool-call caller attribution (#3421 step 1).
//
// Every tool call already writes one tool_calls row at the single writer
// (registry.call). These columns record who made the call: the transport, the
// socket connection, what the client says it is, whether it presented the
// executing session's token, whether it is the turn's own, where the actor came
// from, and whether the tool is admin-gated. They are evidence only; nothing
// reads them to decide anything.
//
// Additive, nullable, no default, no backfill, and deliberately no CHECK
// constraints: the tool_calls insert fails closed (a failed write refuses the
// call), so a constraint violation here would change tool behaviour. The
// allowed values are enforced in TypeScript instead. Rows written before this
// migration, or by paths that carry no attribution, read NULL.
import type { DatabaseSync } from 'node:sqlite';

export const TOOL_CALL_CALLER_COLUMNS = [
  ['caller_transport', 'TEXT'],
  ['caller_connection_id', 'TEXT'],
  ['caller_client_name', 'TEXT'],
  ['caller_client_version', 'TEXT'],
  ['caller_token_result', 'TEXT'],
  ['caller_turn_owned', 'INTEGER'],
  ['caller_actor_source', 'TEXT'],
  ['tool_sensitive', 'INTEGER'],
] as const;

export function runMigration65(db: DatabaseSync): void {
  const names = new Set(
    (db.prepare("PRAGMA table_info('tool_calls')").all() as Array<{ name: string }>)
      .map((c) => c.name),
  );
  // An empty set means the table itself is absent (legacy or partial fixtures);
  // such databases carry no tool rows to attribute.
  if (names.size === 0) return;

  for (const [name, type] of TOOL_CALL_CALLER_COLUMNS) {
    if (!names.has(name)) {
      db.exec(`ALTER TABLE tool_calls ADD COLUMN ${name} ${type}`);
    }
  }
}
