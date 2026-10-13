import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Database } from '../../../src/core/database.ts';
import {
  ensureFallbackStateSchema,
  saveFallbackState,
  getFallbackState,
  clearFallbackState,
  PERSISTED_FALLBACK_STATE_VERSION,
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
    expect(getFallbackState(db)).toStrictEqual(null);
  });

  it('round-trips a saved state', () => {
    clearFallbackState(db);
    const state = {
      activeUntil: 1_700_000_000_000,
      activatedAt: 1_699_999_000_000,
      reason: 'usage-limit',
      probeAttempts: 7,
      version: 1,
      activeEntryProvider: 'opencode-cli',
      activeEntryModel: 'minimax/minimax-m2',
      failedKeys: [{ provider: 'claude-cli', model: '' }],
      recoveryEpisodeStartedAt: 1_699_999_000_000,
      recoveryState: 'active' as const,
      recoveryTerminalReason: null,
      recoveryProbeInFlight: false,
      failedKeysEvidenceAvailability: 'available' as const,
      recoveryEvidenceAvailability: 'available' as const,
      fallbackStateEvidenceAvailability: 'available' as const,
    };
    saveFallbackState(db, state);
    const loaded = getFallbackState(db);
    expect(loaded).toEqual(state);
  });

  it('upsert: second save replaces the singleton row', () => {
    clearFallbackState(db);
    saveFallbackState(db, {
      activeUntil: 1_700_000_000_000,
      activatedAt: 1_699_999_000_000,
      reason: 'usage-limit',
      probeAttempts: 0,
      version: 1,
      activeEntryProvider: null,
      activeEntryModel: null,
      failedKeys: [],
    });
    const updated = {
      activeUntil: 1_800_000_000_000,
      activatedAt: 1_799_999_000_000,
      reason: 'restored',
      probeAttempts: 3,
      version: 1,
      activeEntryProvider: 'opencode-cli',
      activeEntryModel: null,
      failedKeys: [],
    };
    saveFallbackState(db, updated);
    const loaded = getFallbackState(db);
    expect(loaded?.activeUntil).toBe(1_800_000_000_000);
    expect(loaded?.reason).toBe('restored');
    expect(loaded?.probeAttempts).toBe(3);
  });

  it('clear removes the row and is idempotent', () => {
    saveFallbackState(db, {
      activeUntil: 1_700_000_000_000,
      activatedAt: 1_699_999_000_000,
      reason: 'usage-limit',
      probeAttempts: 0,
      version: 1,
      activeEntryProvider: null,
      activeEntryModel: null,
      failedKeys: [],
    });
    clearFallbackState(db);
    expect(getFallbackState(db)).toBeNull();
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
      probeAttempts: 0,
      version: 1,
      activeEntryProvider: null,
      activeEntryModel: null,
      failedKeys: [],
    });
    const loaded = getFallbackState(db);
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

  it('marks a present row with wrong-typed core data unavailable instead of treating it as absent', () => {
    clearFallbackState(db);
    // SQLite type affinity lets us store TEXT in an INTEGER column.
    // Insert malformed data directly to test the loader's guard.
    db.raw
      .prepare(
        `INSERT INTO agent_fallback_state (id, active_until, activated_at, reason)
         VALUES (1, 'not-a-number', 1699999000000, 'usage-limit')`,
      )
      .run();
    // The loader keeps the raw row distinguishable from no state so restore
    // can quarantine it rather than route primary.
    expect(getFallbackState(db)).toMatchObject({
      fallbackStateEvidenceAvailability: 'unavailable',
    });
  });

  it('migrates a legacy table without probe_attempts: ensure adds the column, old rows load as 0', () => {
    // A pre-existing database created by an older build has the 4-column
    // table. ensureFallbackStateSchema must add probe_attempts in place
    // (ALTER-tolerant) without disturbing the persisted window.
    const legacyPath = tempDbPath();
    const legacyDb = new Database(legacyPath);
    legacyDb.open();
    try {
      legacyDb.raw.exec(`
        CREATE TABLE agent_fallback_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          active_until INTEGER NOT NULL,
          activated_at INTEGER NOT NULL,
          reason TEXT NOT NULL DEFAULT 'usage-limit'
        )
      `);
      legacyDb.raw
        .prepare(
          `INSERT INTO agent_fallback_state (id, active_until, activated_at, reason)
           VALUES (1, 1700000000000, 1699999000000, 'auth-required')`,
        )
        .run();

      ensureFallbackStateSchema(legacyDb);
      // Idempotent against the already-migrated table too.
      expect(() => ensureFallbackStateSchema(legacyDb)).not.toThrow();

      const loaded = getFallbackState(legacyDb);
      expect(loaded).toEqual({
        activeUntil: 1_700_000_000_000,
        activatedAt: 1_699_999_000_000,
        reason: 'auth-required',
        probeAttempts: 0,
        // #3019: additive migration — legacy row without the new columns
        // reads back with legacy defaults (version 0, no identity, no failed keys).
        version: 0,
        activeEntryProvider: null,
        activeEntryModel: null,
        failedKeys: [],
        recoveryEpisodeStartedAt: 1_699_999_000_000,
        recoveryState: 'active',
        recoveryTerminalReason: null,
        recoveryProbeInFlight: false,
        failedKeysEvidenceAvailability: 'available',
        recoveryEvidenceAvailability: 'available',
        fallbackStateEvidenceAvailability: 'available',
      });
    } finally {
      legacyDb.close();
      for (const suffix of ['', '-wal', '-shm']) {
        const fp = legacyPath + suffix;
        if (existsSync(fp)) unlinkSync(fp);
      }
    }
  });

  it('coerces a corrupt probe_attempts value to 0 without discarding the window', () => {
    clearFallbackState(db);
    // probe_attempts is additive observability — a corrupt value must not
    // invalidate an otherwise valid persisted window (unlike the window
    // fields themselves, which null the whole row).
    db.raw
      .prepare(
        `INSERT INTO agent_fallback_state (id, active_until, activated_at, reason, probe_attempts)
         VALUES (1, 1700000000000, 1699999000000, 'auth-required', 'garbage')`,
      )
      .run();
    const loaded = getFallbackState(db);
    expect(loaded).toEqual({
      activeUntil: 1_700_000_000_000,
      activatedAt: 1_699_999_000_000,
      reason: 'auth-required',
      probeAttempts: 0,
      version: 0,
      activeEntryProvider: null,
      activeEntryModel: null,
      failedKeys: [],
      recoveryEpisodeStartedAt: 1_699_999_000_000,
      recoveryState: 'active',
      recoveryTerminalReason: null,
      recoveryProbeInFlight: false,
      failedKeysEvidenceAvailability: 'available',
      recoveryEvidenceAvailability: 'available',
      fallbackStateEvidenceAvailability: 'available',
    });
  });

  it('quarantines malformed failed-provider evidence instead of coercing it to an empty set', () => {
    clearFallbackState(db);
    saveFallbackState(db, {
      activeUntil: 1_700_000_000_000,
      activatedAt: 1_699_999_000_000,
      reason: 'auth-required',
      probeAttempts: 0,
      version: 2,
      activeEntryProvider: 'opencode-cli',
      activeEntryModel: 'minimax/minimax-m2',
      failedKeys: [],
    });
    db.raw.prepare(`UPDATE agent_fallback_state SET failed_keys_json = ? WHERE id = 1`)
      .run('{malformed-json');

    const loaded = getFallbackState(db);
    expect(loaded?.failedKeys).toEqual([]);
    expect(loaded?.failedKeysEvidenceAvailability).toBe('unavailable');
  });

  it.each([
    ['recovery_state', 'not-a-recovery-state'],
    ['recovery_terminal_reason', 'not-a-terminal-reason'],
    ['recovery_episode_started_at', 'not-an-epoch'],
    ['recovery_probe_in_flight', 2],
  ])('marks malformed version-2 %s as unavailable evidence without rewriting the row', (column, value) => {
    clearFallbackState(db);
    saveFallbackState(db, {
      activeUntil: 1_700_000_000_000,
      activatedAt: 1_699_999_000_000,
      reason: 'auth-required',
      probeAttempts: 0,
      version: PERSISTED_FALLBACK_STATE_VERSION,
      activeEntryProvider: 'opencode-cli',
      activeEntryModel: 'minimax/minimax-m2',
      failedKeys: [],
    });
    db.raw.prepare(`UPDATE agent_fallback_state SET ${column} = ? WHERE id = 1`).run(value);

    const loaded = getFallbackState(db);
    expect(loaded?.recoveryEvidenceAvailability).toBe('unavailable');
    const raw = db.raw.prepare(`SELECT ${column} AS value FROM agent_fallback_state WHERE id = 1`)
      .get() as { value: unknown };
    expect(raw.value).toBe(value);
  });

  it('keeps legacy version-1 recovery defaults compatible even when additive recovery columns are malformed', () => {
    clearFallbackState(db);
    saveFallbackState(db, {
      activeUntil: 1_700_000_000_000,
      activatedAt: 1_699_999_000_000,
      reason: 'auth-required',
      probeAttempts: 0,
      version: 1,
      activeEntryProvider: 'opencode-cli',
      activeEntryModel: 'minimax/minimax-m2',
      failedKeys: [],
    });
    db.raw.prepare(
      `UPDATE agent_fallback_state
       SET probe_attempts = 'not-a-count',
           active_entry_provider = NULL,
           active_entry_model = CAST(X'01' AS BLOB),
           recovery_episode_started_at = 'not-an-epoch',
           recovery_state = 'not-a-recovery-state',
           recovery_terminal_reason = 'not-a-terminal-reason',
           recovery_probe_in_flight = 2
       WHERE id = 1`,
    ).run();

    expect(getFallbackState(db)).toMatchObject({
      version: 1,
      recoveryEvidenceAvailability: 'available',
      probeAttempts: 0,
      activeEntryProvider: null,
      activeEntryModel: null,
      recoveryEpisodeStartedAt: 1_699_999_000_000,
      recoveryState: 'active',
      recoveryTerminalReason: null,
      recoveryProbeInFlight: false,
    });
  });
});
