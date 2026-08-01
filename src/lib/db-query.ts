import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

/**
 * Typed SQLite query helpers. `node:sqlite` statements return
 * `Record<string, SQLOutputValue>`, so every call site needs a cast to its
 * row type; these wrappers centralize that single cast so consumers never
 * write `as unknown as Row[]` inline. The cast is a compile-time claim only —
 * no runtime validation is performed.
 */

/** Run a query and return all rows typed as T. */
export function queryAll<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

/** Run a query and return the first row typed as T, or undefined when no row matches. */
export function queryOne<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
