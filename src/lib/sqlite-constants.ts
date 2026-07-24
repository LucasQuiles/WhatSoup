// src/lib/sqlite-constants.ts
// Single source of truth for SQLite pragma configuration values.
// Importable from any architectural layer (no dependencies).

/**
 * SQLite busy_timeout in milliseconds. When two DB connections contend for a
 * write lock, the loser waits this long before returning SQLITE_BUSY. Centralized
 * here so every connection uses the same value — inconsistent busy_timeouts
 * caused silent failures in a prior incident (one site waited longer than
 * another, masking lock contention).
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

/**
 * The full PRAGMA statement string. Use this in place of the literal
 * `'PRAGMA busy_timeout = 5000'` so a value change is a single-file edit.
 * Enforced by the no-magic-sqlite-pragma ESLint rule and
 * tests/scripts/sqlite-busy-timeout-ssot.test.ts.
 */
export const SQLITE_BUSY_TIMEOUT_PRAGMA = `PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`;
