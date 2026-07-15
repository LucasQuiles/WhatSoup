/**
 * Migration-integrity self-heal — issue #1778, Defect A.
 *
 * `verifyRequiredTables()` used to carry a one-table allowlist (`chat_aliases`):
 * a migration recorded as applied while its table was absent went undetected for
 * every OTHER table, so the next missing table surfaced as a health-probe error
 * storm instead of a self-heal. These tests pin the generalized behaviour:
 * ANY table the recorded migration chain should have produced is recreated on
 * open, driven by the migration registry rather than a hand-maintained list.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';

function tableExists(db: Database, name: string): boolean {
  return (
    db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) as { name: string } | undefined
  ) !== undefined;
}

function indexExists(db: Database, name: string): boolean {
  return (
    db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
      .get(name) as { name: string } | undefined
  ) !== undefined;
}

describe('migration-integrity self-heal (#1778)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-1778-'));
    dbPath = join(dir, 'test.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('recreates a NON-allowlisted table (pending_polls) dropped behind a recorded migration', () => {
    const first = new Database(dbPath);
    first.open();
    // Precondition: the table exists and its migration (28) is recorded.
    expect(tableExists(first, 'pending_polls')).toBe(true);
    expect(
      first.raw.prepare('SELECT COUNT(*) AS c FROM schema_migrations WHERE version = 28').get(),
    ).toEqual({ c: 1 });

    // Simulate the observed drift: the table vanishes but its migration stays
    // recorded, so runPendingMigrations will never re-run it.
    first.raw.exec('DROP TABLE pending_polls');
    expect(tableExists(first, 'pending_polls')).toBe(false);
    expect(
      first.raw.prepare('SELECT COUNT(*) AS c FROM schema_migrations WHERE version = 28').get(),
    ).toEqual({ c: 1 });
    first.close();

    // Restart: reopening must detect the phantom migration and self-heal.
    const second = new Database(dbPath);
    second.open();
    expect(tableExists(second, 'pending_polls')).toBe(true);
    // The health probe (`SELECT COUNT(*) FROM pending_polls`) must no longer throw.
    expect(() =>
      second.raw.prepare('SELECT COUNT(*) AS cnt FROM pending_polls').get(),
    ).not.toThrow();
    // Indexes belonging to the recreated table are restored too.
    expect(indexExists(second, 'idx_pending_polls_chat_jid')).toBe(true);
    second.close();
  });

  it('still recreates the originally-allowlisted table (chat_aliases) — generalization covers the old case', () => {
    const first = new Database(dbPath);
    first.open();
    expect(tableExists(first, 'chat_aliases')).toBe(true);
    first.raw.exec('DROP TABLE chat_aliases');
    expect(tableExists(first, 'chat_aliases')).toBe(false);
    first.close();

    const second = new Database(dbPath);
    second.open();
    expect(tableExists(second, 'chat_aliases')).toBe(true);
    second.close();
  });

  it('linchpin: canonical migrated-table set equals a freshly-opened DB\'s user tables', async () => {
    // Both sides are built from scratch, so this proves the in-memory replay
    // reproduces the real schema (a future migration that does not replay
    // cleanly turns this red). It CANNOT catch divergence on an incrementally
    // upgraded DB — that path is exercised by the self-heal cases above.
    const mod = await import('../../src/core/database.ts');
    const snapshot = mod.migratedSchemaSnapshot() as Map<string, unknown>;
    const canonical = new Set(snapshot.keys());

    const fresh = new Database(':memory:');
    fresh.open();
    const live = new Set(
      (
        fresh.raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name),
    );
    fresh.close();

    expect(canonical).toEqual(live);
  });
});
