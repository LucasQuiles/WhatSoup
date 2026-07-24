// src/lib/db-query.ts
// Typed query wrappers for node:sqlite DatabaseSync.
//
// Centralizes the `as T[]` / `as T` cast that every SQLite consumer in the
// codebase reimplements with different patterns (as any, as unknown as, etc.).
// node:sqlite's .all() returns `unknown[]` and .get() returns `unknown`; this
// wrapper puts the cast in ONE place so it's auditable and consistent.
//
// Phase 1 (this module): centralizes the cast. No runtime validation yet.
// Phase 2 (future): add zod/valibot schema validation for query results.
//
// See #2191 for the full design rationale.

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

/**
 * Execute a query and return typed rows. Replaces the inline
 * `db.prepare(sql).all(...params) as T[]` pattern.
 *
 * @example
 * const rows = queryAll<MessageRow>(db, 'SELECT * FROM messages WHERE ...', id);
 */
export function queryAll<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T[] {
  const stmt = db.prepare(sql);
  return stmt.all(...params) as T[];
}

/**
 * Execute a query and return a single typed row (or undefined). Replaces the
 * inline `db.prepare(sql).get(...params) as T` pattern.
 *
 * @example
 * const row = queryOne<CountRow>(db, 'SELECT COUNT(*) as c FROM messages');
 */
export function queryOne<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T | undefined {
  const stmt = db.prepare(sql);
  return stmt.get(...params) as T | undefined;
}
