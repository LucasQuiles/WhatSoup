/**
 * Unit tests for the extracted fallback-restore module (#3019 car-14 v2).
 *
 * These target the module's edge branches directly with a synthetic
 * FallbackRestoreContext — behavior the integration suite reaches only
 * through the full runtime:
 *
 * U1: a malformed failed key with no provider\u0000model separator
 *     serializes as { provider, model: '' } instead of crashing.
 * U2: null-model chain entries match a persisted null activeEntryModel;
 *     unconfigured persisted failedKeys are skipped (never restored);
 *     a non-finite persisted probeAttempts restores as 0.
 * U3: chain-mismatch with a null persisted model reports the 'default'
 *     placeholder in the alert detail and clears state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked: vi.fn(),
}));

import { Database } from '../../../src/core/database.ts';
import {
  ensureFallbackStateSchema,
  saveFallbackState,
  getFallbackState,
  PERSISTED_FALLBACK_STATE_VERSION,
} from '../../../src/runtimes/agent/fallback-state-db.ts';
import {
  failedKeysToPersistedKeys,
  restorePersistedFallbackWindowState,
  type FallbackRestoreContext,
} from '../../../src/runtimes/agent/fallback-restore.ts';
import { emitAlertChecked } from '../../../src/lib/emit-alert.ts';

const NOW = 1_786_000_000_000;
const WINDOW_MS = 30 * 60 * 1000;

let dbPath: string;
let db: Database;

beforeEach(() => {
  dbPath = join(tmpdir(), `fallback-restore-unit-${randomBytes(6).toString('hex')}.db`);
  db = new Database(dbPath);
  ensureFallbackStateSchema(db);
  vi.mocked(emitAlertChecked).mockClear();
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const p = `${dbPath}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
});

function makeCtx(over: Partial<FallbackRestoreContext> = {}): FallbackRestoreContext & {
  added: string[];
  resetCalls: number[];
} {
  const added: string[] = [];
  const resetCalls: number[] = [];
  const ctx = {
    db,
    agentFallbacks: [
      { provider: 'opencode-cli', model: 'glm' },
      { provider: 'anthropic-api' }, // model undefined -> null-model entry
    ] as FallbackRestoreContext['agentFallbacks'],
    resetFailedKeys: () => {
      resetCalls.push(1);
    },
    addFailedKey: (key: string) => {
      added.push(key);
    },
    entryKeyFor: (provider: string, model: string | null) => `${provider}\u0000${model ?? ''}`,
    ...over,
  };
  return Object.assign(ctx, { added, resetCalls }) as FallbackRestoreContext & {
    added: string[];
    resetCalls: number[];
  };
}

describe('fallback-restore module unit branches', () => {
  it('U1: failedKeysToPersistedKeys serializes a separator-less key as empty-model, not a crash', () => {
    const keys = new Set<string>(['anthropic-api\u0000opus', 'bare-provider-no-separator']);
    const persisted = failedKeysToPersistedKeys(keys);
    expect(persisted).toContainEqual({ provider: 'anthropic-api', model: 'opus' });
    expect(persisted).toContainEqual({ provider: 'bare-provider-no-separator', model: '' });
  });

  it('U2: null-model entry matches persisted null model; unconfigured failed keys are skipped; non-finite probeAttempts restores as 0', () => {
    saveFallbackState(db, {
      activeUntil: NOW + 10 * 60 * 1000,
      activatedAt: NOW - 60 * 1000,
      reason: 'unit-restore',
      probeAttempts: 3,
      version: PERSISTED_FALLBACK_STATE_VERSION,
      activeEntryProvider: 'anthropic-api',
      activeEntryModel: null, // matches the model-less configured entry via ?? null
      failedKeys: [
        { provider: 'anthropic-api' } as unknown as { provider: string; model: string }, // model-less legacy entry: DROPPED at the read boundary, never restored
        { provider: 'opencode-cli', model: 'glm' }, // configured -> restored
        { provider: 'anthropic-api', model: 'ghost-model' }, // provider matches the null-model entry, model does not -> skipped
        { provider: 'ghost-provider', model: 'gone' }, // NOT configured -> skipped
      ],
    });
    // Corrupt the persisted probe_attempts out-of-band: SQLite's dynamic typing
    // accepts a string (NOT NULL satisfied), which reads back as NaN — the row
    // shape the Number.isFinite guard exists for (legacy/tampered rows, not
    // the saveFallbackState path, which cannot produce it).
    db.raw.prepare(`UPDATE agent_fallback_state SET probe_attempts = 'corrupt' WHERE id = 1`).run();
    const ctx = makeCtx();
    const result = restorePersistedFallbackWindowState(ctx, WINDOW_MS, () => NOW);
    expect(result.outcome).toBe('armed');
    if (result.outcome !== 'armed') return;
    // The corrupt row is sanitized at the db read boundary (getFallbackState),
    // so the restore result reports 0, never NaN.
    expect(result.persistedProbeAttempts).toBe(0);
    // Only configured keys restored: the ghost provider is skipped, and the
    // model-less legacy entry was dropped at the read boundary (never restored).
    expect(ctx.added).toContain('opencode-cli\u0000glm');
    expect(ctx.added.some((k) => k.startsWith('anthropic-api'))).toBe(false);
    expect(ctx.added.some((k) => k.startsWith('ghost-provider'))).toBe(false);
    expect(ctx.resetCalls).toHaveLength(1);
    // restoredFailedKeys counts exactly the one fully-configured entry (the
    // provider-match/model-mismatch key is skipped like the ghost).
    expect(result.restoredFailedKeys).toBe(1);
  });

  it('U3: chain-mismatch with null persisted model clears state and reports the default placeholder', () => {
    saveFallbackState(db, {
      activeUntil: NOW + 10 * 60 * 1000,
      activatedAt: NOW - 60 * 1000,
      reason: 'unit-mismatch',
      probeAttempts: 2,
      version: PERSISTED_FALLBACK_STATE_VERSION,
      activeEntryProvider: 'removed-provider', // not in the configured chain
      activeEntryModel: null,
      failedKeys: [],
    });
    const ctx = makeCtx();
    const result = restorePersistedFallbackWindowState(ctx, WINDOW_MS, () => NOW);
    expect(result).toEqual({ outcome: 'chain-mismatch', cleared: true });
    // State cleared: a second read finds nothing to restore.
    expect(getFallbackState(db)).toBeNull();
    // The alert detail renders the null model as the 'default' placeholder.
    const call = vi.mocked(emitAlertChecked).mock.calls.find((c) => c[1] === 'fallback_persist_chain_mismatch');
    expect(call).toBeDefined();
    expect(String(call?.[3])).toContain('persistedModel=default');
  });
});
