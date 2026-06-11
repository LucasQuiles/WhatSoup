import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Database } from '../../../src/core/database.ts';
import {
  ensureFallbackStateSchema,
  saveFallbackState,
  loadFallbackState,
  clearFallbackState,
} from '../../../src/runtimes/agent/fallback-state-db.ts';

function tempDbPath(): string {
  return join(tmpdir(), `whatsoup-fallback-state-test-${randomBytes(4).toString('hex')}.db`);
}

const dbPath = tempDbPath();
const db = new Database(dbPath);
db.open();
ensureFallbackStateSchema(db);

afterAll(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const fp = dbPath + suffix;
    if (existsSync(fp)) unlinkSync(fp);
  }
});

describe('fallback-state-db', () => {
  it('returns null when nothing is persisted', () => {
    // Ensure clean state
    clearFallbackState(db);
    expect(loadFallbackState(db)).toStrictEqual(null);
  });

  it('round-trips a saved state', () => {
    clearFallbackState(db);
    const state = {
      activeUntil: 1_700_000_000_000,
      activatedAt: 1_699_999_000_000,
      reason: 'usage-limit',
    };
    saveFallbackState(db, state);
    const loaded = loadFallbackState(db);
    expect(loaded).toEqual(state);
  });

  it('upsert: second save replaces the singleton row', () => {
    clearFallbackState(db);
    saveFallbackState(db, {
      activeUntil: 1_700_000_000_000,
      activatedAt: 1_699_999_000_000,
      reason: 'usage-limit',
    });
    const updated = {
      activeUntil: 1_800_000_000_000,
      activatedAt: 1_799_999_000_000,
      reason: 'restored',
    };
    saveFallbackState(db, updated);
    const loaded = loadFallbackState(db);
    expect(loaded?.activeUntil).toBe(1_800_000_000_000);
    expect(loaded?.reason).toBe('restored');
  });

  it('clear removes the row and is idempotent', () => {
    saveFallbackState(db, {
      activeUntil: 1_700_000_000_000,
      activatedAt: 1_699_999_000_000,
      reason: 'usage-limit',
    });
    clearFallbackState(db);
    expect(loadFallbackState(db)).toBeNull();
    // Double-clear: must not throw
    expect(() => clearFallbackState(db)).not.toThrow();
  });

  it('ensureFallbackStateSchema is idempotent (call twice, still works)', () => {
    expect(() => ensureFallbackStateSchema(db)).not.toThrow();
    clearFallbackState(db);
    saveFallbackState(db, {
      activeUntil: 1_700_000_000_000,
      activatedAt: 1_699_999_000_000,
      reason: 'usage-limit',
    });
    const loaded = loadFallbackState(db);
    expect(loaded).not.toBeNull();
  });

  it('NOT NULL constraint rejects a save with null active_until via raw insert', () => {
    clearFallbackState(db);
    expect(() => {
      db.raw
        .prepare(
          `INSERT INTO agent_fallback_state (id, active_until, activated_at, reason)
           VALUES (1, NULL, 1699999000000, 'usage-limit')`,
        )
        .run();
    }).toThrow();
  });

  it('loadFallbackState returns null when a row has wrong-typed data (type validation)', () => {
    clearFallbackState(db);
    // SQLite type affinity lets us store TEXT in an INTEGER column.
    // Insert malformed data directly to test the loader's guard.
    db.raw
      .prepare(
        `INSERT INTO agent_fallback_state (id, active_until, activated_at, reason)
         VALUES (1, 'not-a-number', 1699999000000, 'usage-limit')`,
      )
      .run();
    // The loader must return null rather than propagating garbage.
    expect(loadFallbackState(db)).toStrictEqual(null);
  });
});
