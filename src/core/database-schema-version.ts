/** Highest schema migration understood by this binary. Dependency-free so the
 * pre-main compatibility gate can compare a read-only ledger without importing
 * logger/config/runtime modules. database.ts asserts this stays aligned with
 * its canonical migration registry. */
export const CURRENT_SCHEMA_MIGRATION = 46;
