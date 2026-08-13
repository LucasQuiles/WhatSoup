/**
 * #3019 discriminating tests: fallback chain persistence across restart.
 *
 * D1: A-fails/B-active restart restores B and keeps A ineligible
 *     (MUST FAIL if persistence removed — without failedKeys persistence,
 *     restart re-arms against an empty chain and retries A).
 * D2: same-provider/different-model entries are distinct across restart
 *     (failedKeys are provider+model keyed; a failed model does not
 *     invalidate a different model on the same provider).
 * D3: chain-mismatch classes -> explicit reconciliation state (removed/
 *     reordered active-entry identity is cleared, never silently re-routed).
 * D4: persistence-failure -> degraded readiness, not durable-recovery
 *     (saveFallbackState throwing does not crash the window; the in-memory
 *     window continues but the next restart won't see it).
 * D5: health exposes content-free restored+failed continuity evidence
 *     (fallbackRestoredFromPersist + failedEntryCount, no credentials/
 *     account/paths/message content).
 * D6: single-entry + existing recovery tests unchanged (the restore path
 *     with a legacy version-0 row still re-arms on the single fallback).
 *
 * Real-database integration pattern (mirrors fallback-persistence-
 * integration.test.ts): genuine on-disk SQLite, temp file, afterEach cleanup.
 * Mocks for config/registry/keyring mirror provider-fallback.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Database } from '../../../src/core/database.ts';
import {
  ensureFallbackStateSchema,
  saveFallbackState,
  getFallbackState,
  PERSISTED_FALLBACK_STATE_VERSION,
} from '../../../src/runtimes/agent/fallback-state-db.ts';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../../src/config.ts', () => {
  const config: Record<string, unknown> = {
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full',
    toolUpdateRedirectJid: null,
    textAggregateDelayMs: 2_000,
    mediaDir: '/tmp/whatsoup-test-media-fallback-chain-persistence-3019/tmp',
    voiceReply: 'never',
    elevenlabs: {
      defaultVoiceId: 'v',
      defaultModel: 'eleven_multilingual_v2',
      stability: 0.5,
      similarityBoost: 0.75,
    },
    agentMaxQueueDepth: 25,
    agentProvider: 'claude-cli',
    agentProviderConfig: undefined,
    // Multi-entry fallback chain: A (opencode-cli) then B (anthropic-api).
    // Tests mutate this via mockConfigRef() before constructing runtimes.
    agentFallbacks: [
      { provider: 'opencode-cli', model: 'minimax/minimax-m2' },
      { provider: 'anthropic-api', model: 'claude-sonnet-4-5' },
    ],
  };
  (globalThis as Record<string, unknown>)['__ws3019TestConfig__'] = config;
  return { config };
});

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__ws3019TestConfig__'] as Record<string, unknown>;
}

vi.mock('../../../src/mcp/register-all.ts', () => ({
  registerAllTools: vi.fn(),
}));

vi.mock('../../../src/lib/emit-alert.ts', () => {
  const emitAlert = vi.fn(() => true);
  const clearAlertSource = vi.fn(() => true);
  return {
    emitAlert,
    emitAlertChecked: emitAlert,
    clearAlertSource,
    clearAlertSourceChecked: clearAlertSource,
  };
});

vi.mock('../../../src/runtimes/agent/providers/binary-preflight.ts', () => ({
  probeFallbackBinary: vi.fn(() => Promise.resolve({ status: 'unknown', version: null })),
  probeModelCatalog: vi.fn(() => Promise.resolve({ status: 'unknown', suggestion: null })),
}));

vi.mock('../../../src/mcp/registry.ts', () => ({
  ToolRegistry: class {
    register = vi.fn();
    listTools = vi.fn(() => []);
    call = vi.fn();
    getChatScopedToolNames = vi.fn(() => []);
    setDurability = vi.fn();
  },
}));

vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...actual,
    // Return a non-null credential so isEntryCredentialed returns true for
    // all fallback entries — the chain selection skips uncredentialed entries.
    lookupCredential: (_service: string) => 'test-key-present',
  };
});

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { Messenger } from '../../../src/core/types.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tempDbPath(): string {
  return join(tmpdir(), `ws3019-fallback-test-${randomBytes(4).toString('hex')}.db`);
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

function makeRuntime(db: Database): AgentRuntime {
  return new AgentRuntime(db, makeMessenger(), 'ws3019-test', {
    model: 'claude-opus-4-8[1m]',
  });
}

type FallbackView = {
  fallbackWindow: { activeUntil: number | null; activeEntry: { provider: string; model?: string } | null };
  fallbackProbeAttempts: number;
  fallbackWindowRestored: boolean;
  effectiveProvider: string;
  fallbackChain: {
    failedKeys: Set<string>;
    entryKey(entry: { provider: string; model?: string }): string;
    chainState: Array<{ provider: string; model?: string; eligible: boolean }>;
  };
  probePrimaryProviderRecovered(): boolean | Promise<boolean>;
  activateProviderFallback(
    resetAt: Date | null,
    reason?: 'usage-limit' | 'rate-limit' | 'auth-required' | 'model-unavailable' | 'server-error',
  ): void;
  restorePersistedFallbackWindow(): void;
  getFallbackState(): {
    fallbackRestoredFromPersist: boolean;
    failedEntryCount: number;
    fallbackChainExhausted: boolean;
    effectiveProvider: string;
  };
};

function fbView(runtime: AgentRuntime): FallbackView {
  return runtime as unknown as FallbackView;
}

const RECHECK_MS = 5 * 60 * 1000;

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('#3019 fallback chain persistence across restart', () => {
  let dbPath: string;
  let db: Database;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    dbPath = tempDbPath();
    db = new Database(dbPath);
    db.open();
    ensureFallbackStateSchema(db);
    // Default multi-entry chain for D1-D5; D6 overrides to single-entry.
    mockConfigRef()['agentFallbacks'] = [
      { provider: 'opencode-cli', model: 'minimax/minimax-m2' },
      { provider: 'anthropic-api', model: 'claude-sonnet-4-5' },
    ];
  });

  afterEach(() => {
    vi.useRealTimers();
    try { db.close(); } catch { /* best-effort */ }
    for (const suffix of ['', '-wal', '-shm']) {
      const fp = dbPath + suffix;
      if (existsSync(fp)) unlinkSync(fp);
    }
  });

  // D1: A-fails/B-active restart restores B and keeps A ineligible
  it('D1: restart restores the active B entry and keeps failed A ineligible (MUST FAIL if persistence removed)', () => {
    // Runtime A: activate fallback -> selects entry A (opencode-cli, first eligible).
    const runtimeA = makeRuntime(db);
    const vA = fbView(runtimeA);
    vA.activateProviderFallback(null, 'usage-limit');
    expect(vA.effectiveProvider).toBe('opencode-cli');

    // Simulate entry A failing during the window -> markActiveFallbackFailed
    // adds A's key to failedKeys. We do this by directly adding to the Set
    // (the integration test cannot easily drive a real session failure).
    vA.fallbackChain.failedKeys.add(vA.fallbackChain.entryKey({ provider: 'opencode-cli', model: 'minimax/minimax-m2' }));

    // Re-arm to force a re-save that includes the failedKeys. Since A is now
    // in failedKeys, selectFallbackEntryForWindow skips it and selects B
    // (anthropic-api) — the correct cascade behavior.
    vA.activateProviderFallback(null, 'usage-limit');
    expect(vA.effectiveProvider).toBe('anthropic-api');

    // The armFallbackWindow save must have persisted both the failedKeys
    // (A's key) and the new active-entry identity (B).
    const row1 = getFallbackState(db);
    expect(row1).not.toBeNull();
    expect(row1!.version).toBe(PERSISTED_FALLBACK_STATE_VERSION);
    expect(row1!.activeEntryProvider).toBe('anthropic-api');
    expect(row1!.failedKeys).toContainEqual({ provider: 'opencode-cli', model: 'minimax/minimax-m2' });

    // Runtime B (restarted process) over the same DB restores the window.
    const runtimeB = makeRuntime(db);
    const vB = fbView(runtimeB);
    vB.restorePersistedFallbackWindow();

    // The restored window must have reconstituted failedKeys — A is still
    // ineligible. This is the core discrimination: without persistence, the
    // restart would see an empty failedKeys and could re-select A.
    expect(vB.fallbackChain.failedKeys.has(
      vB.fallbackChain.entryKey({ provider: 'opencode-cli', model: 'minimax/minimax-m2' }),
    )).toBe(true);

    // The restored active entry is B (anthropic-api), not A.
    expect(vB.fallbackWindow.activeEntry).not.toBeNull();
    expect(vB.fallbackWindow.activeEntry!.provider).toBe('anthropic-api');

    // Health snapshot shows the restored continuity evidence.
    const health = vB.getFallbackState();
    expect(health.fallbackRestoredFromPersist).toBe(true);
    expect(health.failedEntryCount).toBe(1);
  });

  // D2: same-provider/different-model entries are distinct across restart
  it('D2: same-provider/different-model failed keys are distinct across restart', () => {
    // Configure a chain with two models on the same provider.
    mockConfigRef()['agentFallbacks'] = [
      { provider: 'opencode-cli', model: 'minimax/minimax-m2' },
      { provider: 'opencode-cli', model: 'deepseek/deepseek-chat' },
    ];

    const runtimeA = makeRuntime(db);
    const vA = fbView(runtimeA);
    vA.activateProviderFallback(null, 'usage-limit');

    // Fail only the first model — the second model on the same provider
    // must remain eligible (distinct provider+model keys).
    vA.fallbackChain.failedKeys.add(
      vA.fallbackChain.entryKey({ provider: 'opencode-cli', model: 'minimax/minimax-m2' }),
    );
    vA.activateProviderFallback(null, 'usage-limit'); // re-save with failedKeys

    const row = getFallbackState(db);
    expect(row!.failedKeys).toContainEqual({ provider: 'opencode-cli', model: 'minimax/minimax-m2' });
    expect(row!.failedKeys).not.toContainEqual({ provider: 'opencode-cli', model: 'deepseek/deepseek-chat' });

    // Restart restores only the failed model's key.
    const runtimeB = makeRuntime(db);
    const vB = fbView(runtimeB);
    vB.restorePersistedFallbackWindow();

    expect(vB.fallbackChain.failedKeys.has(
      vB.fallbackChain.entryKey({ provider: 'opencode-cli', model: 'minimax/minimax-m2' }),
    )).toBe(true);
    expect(vB.fallbackChain.failedKeys.has(
      vB.fallbackChain.entryKey({ provider: 'opencode-cli', model: 'deepseek/deepseek-chat' }),
    )).toBe(false);
  });

  // D3: chain-mismatch classes -> explicit reconciliation state
  it('D3: persisted active-entry not in configured chain -> cleared, never silently re-routed', () => {
    // Persist a state with an active-entry identity for a provider that is
    // NOT in the configured chain (simulating a config change between restarts).
    const futureUntil = Date.now() + 60 * 60_000;
    saveFallbackState(db, {
      activeUntil: futureUntil,
      activatedAt: Date.now() - 1000,
      reason: 'usage-limit',
      probeAttempts: 0,
      version: PERSISTED_FALLBACK_STATE_VERSION,
      activeEntryProvider: 'removed-provider',
      activeEntryModel: 'removed-model',
      failedKeys: [{ provider: 'removed-provider', model: 'removed-model' }],
    });

    // The configured chain is [opencode-cli, anthropic-api] — 'removed-provider'
    // is not present. Restore must clear and proceed on the primary, never
    // silently re-route to a different entry.
    const runtime = makeRuntime(db);
    const v = fbView(runtime);
    v.restorePersistedFallbackWindow();

    expect(v.effectiveProvider).toBe('claude-cli'); // primary, not fallback
    expect(v.fallbackWindow.activeUntil).toBeNull();

    // The DB row must be cleared.
    expect(getFallbackState(db)).toBeNull();

    // Health must NOT show restored (it was cleared, not restored).
    expect(v.getFallbackState().fallbackRestoredFromPersist).toBe(false);
  });

  // D3b: version-incompatible row -> explicit reconciliation
  it('D3b: persisted version newer than known -> cleared, never silently re-routed', () => {
    const futureUntil = Date.now() + 60 * 60_000;
    saveFallbackState(db, {
      activeUntil: futureUntil,
      activatedAt: Date.now() - 1000,
      reason: 'usage-limit',
      probeAttempts: 0,
      version: PERSISTED_FALLBACK_STATE_VERSION + 99, // future version
      activeEntryProvider: 'opencode-cli',
      activeEntryModel: 'minimax/minimax-m2',
      failedKeys: [],
    });

    const runtime = makeRuntime(db);
    const v = fbView(runtime);
    v.restorePersistedFallbackWindow();

    expect(v.effectiveProvider).toBe('claude-cli');
    expect(v.fallbackWindow.activeUntil).toBeNull();
    expect(getFallbackState(db)).toBeNull();
  });

  // D4: persistence-failure -> degraded readiness, not durable-recovery
  it('D4: saveFallbackState throwing does not crash the window (degraded readiness, in-memory continues)', () => {
    // Use a separate DB that we corrupt AFTER constructing the runtime, so
    // ensureFallbackStateSchema already ran but saveFallbackState will fail.
    const corruptDbPath = tempDbPath();
    const corruptDb = new Database(corruptDbPath);
    corruptDb.open();
    ensureFallbackStateSchema(corruptDb);

    const runtime = new AgentRuntime(corruptDb, makeMessenger(), 'ws3019-d4', {
      model: 'claude-opus-4-8[1m]',
    });
    const v = fbView(runtime);

    // Corrupt the table so saveFallbackState's INSERT will throw — drop the
    // table entirely. The armFallbackWindow try/catch must swallow the error
    // and keep the in-memory window active (degraded readiness, not a crash).
    corruptDb.raw.exec(`DROP TABLE agent_fallback_state`);

    // activateProviderFallback calls armFallbackWindow which calls
    // saveFallbackState. The error must be caught — the window stays active
    // in-memory. (ensureFallbackStateSchema is called at restore time, not
    // at activate time, so the drop is not auto-healed here.)
    expect(() => v.activateProviderFallback(null, 'usage-limit')).not.toThrow();
    expect(v.effectiveProvider).toBe('opencode-cli');
    expect(v.fallbackWindow.activeUntil).not.toBeNull();

    // Cleanup
    try { corruptDb.close(); } catch { /* best-effort */ }
    for (const suffix of ['', '-wal', '-shm']) {
      const fp = corruptDbPath + suffix;
      if (existsSync(fp)) unlinkSync(fp);
    }
  });

  // D5: health exposes content-free restored+failed continuity evidence
  it('D5: health snapshot exposes fallbackRestoredFromPersist + failedEntryCount, no credentials/content', () => {
    // Persist a state with a failed key and an active-entry identity.
    const futureUntil = Date.now() + 60 * 60_000;
    saveFallbackState(db, {
      activeUntil: futureUntil,
      activatedAt: Date.now() - 1000,
      reason: 'usage-limit',
      probeAttempts: 2,
      version: PERSISTED_FALLBACK_STATE_VERSION,
      activeEntryProvider: 'opencode-cli',
      activeEntryModel: 'minimax/minimax-m2',
      failedKeys: [{ provider: 'opencode-cli', model: 'minimax/minimax-m2' }],
    });

    const runtime = makeRuntime(db);
    const v = fbView(runtime);
    v.restorePersistedFallbackWindow();

    const health = v.getFallbackState();
    // Content-free continuity evidence: restored flag + failed count.
    expect(health.fallbackRestoredFromPersist).toBe(true);
    expect(health.failedEntryCount).toBe(1);
    // The health snapshot must NOT carry credential/account/path/message content.
    // (We verify structurally: the health object has no keys that look like
    // credentials, paths, or message content — only state scalars + counts.)
    const healthStr = JSON.stringify(health);
    expect(healthStr).not.toMatch(/key|token|secret|password|credential|apiKey|path|message|content/i);
  });

  // D6: single-entry + existing recovery tests unchanged
  it('D6: single-entry chain with a legacy version-0 row still re-arms on the single fallback', () => {
    // Override to a single-entry chain.
    mockConfigRef()['agentFallbacks'] = [
      { provider: 'opencode-cli', model: 'minimax/minimax-m2' },
    ];

    // Persist a LEGACY row (version 0 — no chain identity, no failed keys).
    // This is the pre-#3019 shape; the restore path must handle it as legacy
    // and re-arm without chain reconstitution (preserving prior behavior).
    const futureUntil = Date.now() + 60 * 60_000;
    saveFallbackState(db, {
      activeUntil: futureUntil,
      activatedAt: Date.now() - 1000,
      reason: 'usage-limit',
      probeAttempts: 0,
      version: 0,
      activeEntryProvider: null,
      activeEntryModel: null,
      failedKeys: [],
    });

    const runtime = makeRuntime(db);
    const v = fbView(runtime);
    v.restorePersistedFallbackWindow();

    // Legacy row re-arms on the single fallback (preserves prior behavior).
    expect(v.effectiveProvider).toBe('opencode-cli');
    expect(v.fallbackWindow.activeUntil).not.toBeNull();
    // Legacy row has no failed keys to reconstitute.
    expect(v.fallbackChain.failedKeys.size).toBe(0);
    // But it IS restored from persist.
    expect(v.getFallbackState().fallbackRestoredFromPersist).toBe(true);
  });
});
