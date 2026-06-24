/**
 * Real-database integration test for the runtime↔persistence seam.
 *
 * Unlike the unit tests in provider-fallback.test.ts (which stub the db and
 * spy on fallback-state-db module functions), this file uses a genuine on-disk
 * SQLite Database so the composed path is exercised end-to-end:
 *
 *   activate → real upsert in DB → new runtime over same DB
 *   → restore → expire → row gone
 *
 * Construction pattern mirrors fallback-state-db.test.ts (real Database,
 * temp file, afterEach cleanup). Mocks for config/registry/keyring mirror
 * provider-fallback.test.ts so the AgentRuntime ctor wires correctly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Database } from '../../../src/core/database.ts';
import { ensureFallbackStateSchema } from '../../../src/runtimes/agent/fallback-state-db.ts';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../../src/config.ts', () => {
  const config: Record<string, unknown> = {
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full',
    toolUpdateRedirectJid: null,
    textAggregateDelayMs: 2_000,
    mediaDir: '/tmp/whatsoup-test-media/tmp',
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
    agentFallbackProvider: 'opencode-cli',
    agentFallbackModel: 'minimax/minimax-m2',
  };
  (globalThis as Record<string, unknown>)['__fallbackIntegrationConfig__'] = config;
  return { config };
});

vi.mock('../../../src/mcp/register-all.ts', () => ({
  registerAllTools: vi.fn(),
}));

// Alerts must never leave the test process.
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

// Unit tests must never spawn the real fallback binary; 'unknown' is the
// safe fail-open value (no alert, no version log).
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

// Keyring returns null — key-presence warning does not block activation.
vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...actual,
    lookupCredential: (_service: string) => null,
  };
});

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { Messenger } from '../../../src/core/types.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tempDbPath(): string {
  return join(tmpdir(), `whatsoup-fallback-integration-test-${randomBytes(4).toString('hex')}.db`);
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

function makeRuntime(db: Database): AgentRuntime {
  return new AgentRuntime(db, makeMessenger(), 'integration-test', {
    model: 'claude-opus-4-8[1m]',
  });
}

type FallbackView = {
  fallbackWindow: { activeUntil: number | null };
  fallbackProbeAttempts: number;
  effectiveProvider: string;
  probePrimaryProviderRecovered(): boolean | Promise<boolean>;
  activateProviderFallback(
    resetAt: Date | null,
    reason?: 'usage-limit' | 'rate-limit' | 'auth-required',
  ): void;
  restorePersistedFallbackWindow(): void;
};

function fbView(runtime: AgentRuntime): FallbackView {
  return runtime as unknown as FallbackView;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('fallback persistence — real-DB integration', () => {
  let dbPath: string;
  let db: Database;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    dbPath = tempDbPath();
    db = new Database(dbPath);
    db.open();
    ensureFallbackStateSchema(db);
  });

  afterEach(() => {
    vi.useRealTimers();
    try { db.close(); } catch { /* best-effort */ }
    for (const suffix of ['', '-wal', '-shm']) {
      const fp = dbPath + suffix;
      if (existsSync(fp)) unlinkSync(fp);
    }
  });

  it('activate writes a row, restore reads it, expiry clears it', () => {
    // Runtime A activates fallback — the DB must receive a real upsert.
    const runtimeA = makeRuntime(db);
    fbView(runtimeA).activateProviderFallback(null);

    // The raw DB must have exactly one row with reason='usage-limit'.
    const row = db.raw
      .prepare(
        `SELECT active_until AS activeUntil, activated_at AS activatedAt, reason
         FROM agent_fallback_state WHERE id = 1`,
      )
      .get() as { activeUntil: number; activatedAt: number; reason: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.reason).toBe('usage-limit');
    expect(row!.activeUntil).toBeGreaterThan(Date.now());

    // Runtime B over the same DB restores the window without any mocking.
    const runtimeB = makeRuntime(db);
    fbView(runtimeB).restorePersistedFallbackWindow();
    expect(fbView(runtimeB).effectiveProvider).toBe('opencode-cli');

    // Advance past the default 5h window; the runtime must revert and
    // the DB row must be deleted.
    vi.advanceTimersByTime(5 * 60 * 60 * 1000 + 1);
    expect(fbView(runtimeB).effectiveProvider).toBe('claude-cli');
    expect(fbView(runtimeB).fallbackWindow.activeUntil).toBeNull();

    // The DB row must be gone: count is the behavioral claim, not existence.
    const rowCount = (
      db.raw
        .prepare(`SELECT COUNT(*) AS n FROM agent_fallback_state`)
        .get() as { n: number }
    ).n;
    expect(rowCount).toBe(0);
  });

  it('probe attempts survive a restart mid-stall — the stall clock resumes instead of resetting', async () => {
    const RECHECK_MS = 5 * 60 * 1000; // WHATSOUP_PROVIDER_FALLBACK_PRIMARY_RECHECK_MS default

    // Runtime A: auth-required window at the MIN clamp (1 min) with a dead
    // primary. Expiry enters the extension phase; two failed probes accrue.
    const runtimeA = makeRuntime(db);
    const vA = fbView(runtimeA);
    vA.probePrimaryProviderRecovered = vi.fn(() => false);
    vA.activateProviderFallback(new Date(Date.now() + 1000), 'auth-required');
    await vi.advanceTimersByTimeAsync(60 * 1000 + 1); // attempt 1
    await vi.advanceTimersByTimeAsync(RECHECK_MS); // attempt 2
    expect(vA.fallbackProbeAttempts).toBe(2);

    // The attempts must be IN THE ROW — a process-local counter dies with
    // the process and silently resets the stall clock on every restart.
    const row = db.raw
      .prepare(`SELECT probe_attempts AS probeAttempts FROM agent_fallback_state WHERE id = 1`)
      .get() as { probeAttempts: number } | undefined;
    expect(row?.probeAttempts).toBe(2);

    // Runtime B over the same DB (the restarted process) resumes the count.
    const runtimeB = makeRuntime(db);
    const vB = fbView(runtimeB);
    vB.probePrimaryProviderRecovered = vi.fn(() => false);
    vB.restorePersistedFallbackWindow();
    expect(vB.fallbackProbeAttempts).toBe(2);
    expect(vB.effectiveProvider).toBe('opencode-cli');

    // The next failed extension probe continues the SAME stall episode.
    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(vB.fallbackProbeAttempts).toBe(3);
  });
});
