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
import { ensureFallbackStateSchema, getFallbackState } from '../../../src/runtimes/agent/fallback-state-db.ts';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../../src/config.ts', () => {
  const config: Record<string, unknown> = {
    // #2192 s4b: provider-fallback tunables live on config (defaults mirror the retired IIFEs).
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full',
    toolUpdateRedirectJid: null,
    textAggregateDelayMs: 2_000,
    mediaDir: '/tmp/whatsoup-test-media-fallback-persistence-integration/tmp',
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
    emitObservationChecked: vi.fn(() => true),
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
import type { IncomingMessage, Messenger } from '../../../src/core/types.ts';

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

function makeRuntime(db: Database, messenger: Messenger = makeMessenger()): AgentRuntime {
  return new AgentRuntime(db, messenger, 'integration-test', {
    model: 'claude-opus-4-8[1m]',
  });
}

type FallbackView = {
  fallbackWindow: {
    activeUntil: number | null;
    recoveryState: 'active' | 'terminal' | 'operator-held' | 'unavailable';
    recoveryTerminalReason: string | null;
  };
  fallbackProbeAttempts: number;
  effectiveProvider: string;
  probePrimaryProviderRecovered(): boolean | Promise<boolean>;
  activateProviderFallback(
    resetAt: Date | null,
    reason?: 'usage-limit' | 'rate-limit' | 'auth-required' | 'model-unavailable' | 'server-error',
  ): void;
  restorePersistedFallbackWindow(): void;
  getFallbackState(): {
    recoveryState: 'active' | 'terminal' | 'operator-held' | 'unavailable';
    recoveryTerminalReason: string | null;
    probeAttempts: number;
  };
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

  it('activate writes a row, restore reads it, and a successful expiry probe clears it', async () => {
    // Runtime A activates fallback — the DB must receive a real upsert.
    const runtimeA = makeRuntime(db);
    fbView(runtimeA).activateProviderFallback(null, 'model-unavailable');

    // The raw DB must have exactly one row with reason='model-unavailable'.
    const row = db.raw
      .prepare(
        `SELECT active_until AS activeUntil, activated_at AS activatedAt, reason
         FROM agent_fallback_state WHERE id = 1`,
      )
      .get() as { activeUntil: number; activatedAt: number; reason: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.reason).toBe('model-unavailable');
    expect(row!.activeUntil).toBeGreaterThan(Date.now());

    // A process restart clears A's timers without deleting its durable row.
    // Otherwise both live runtimes race to update the same singleton row at
    // expiry, which is not a restart scenario.
    await runtimeA.shutdown();

    // Runtime B over the same DB restores the window without any mocking.
    const runtimeB = makeRuntime(db);
    fbView(runtimeB).restorePersistedFallbackWindow();
    expect(fbView(runtimeB).effectiveProvider).toBe('opencode-cli');
    const proof = vi.fn(() => true);
    fbView(runtimeB).probePrimaryProviderRecovered = proof as unknown as () => Promise<boolean>;

    // Expiry requests fresh primary proof. Only a successful proof may revert
    // the runtime and clear the durable row.
    await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000 + 1);
    expect(proof).toHaveBeenCalledTimes(1);
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

  it('a crash after durably claiming an expired-window probe holds fallback on restart and never replays the ambiguous probe', async () => {
    const runtimeA = makeRuntime(db);
    const vA = fbView(runtimeA);
    const pendingProbe = new Promise<boolean>(() => {});
    vA.probePrimaryProviderRecovered = vi.fn(() => pendingProbe);
    vA.activateProviderFallback(new Date(Date.now() + 1000), 'auth-required');

    await vi.advanceTimersByTimeAsync(60 * 1000 + 1);
    const claimed = getFallbackState(db);
    expect(claimed?.recoveryProbeInFlight).toBe(true);
    expect(claimed?.probeAttempts).toBe(1);

    const runtimeB = makeRuntime(db);
    const vB = fbView(runtimeB);
    const restartProbe = vi.fn(() => false);
    vB.probePrimaryProviderRecovered = restartProbe as unknown as () => Promise<boolean>;
    vB.restorePersistedFallbackWindow();

    expect(vB.effectiveProvider).toBe('opencode-cli');
    expect(vB.getFallbackState().recoveryState).toBe('operator-held');
    expect(vB.getFallbackState().recoveryTerminalReason).toBe('probe-outcome-unknown');
    await vi.advanceTimersByTimeAsync(3 * 5 * 60 * 1000);
    expect(restartProbe).not.toHaveBeenCalled();

    const held = getFallbackState(db);
    expect(held?.recoveryState).toBe('operator-held');
    expect(held?.recoveryTerminalReason).toBe('probe-outcome-unknown');
    expect(held?.recoveryProbeInFlight).toBe(false);
  });

  it('a crash after terminalization restores the terminal fallback route without resuming automatic recovery', async () => {
    const runtimeA = makeRuntime(db);
    const vA = fbView(runtimeA);
    const failedProbe = vi.fn(() => false);
    vA.probePrimaryProviderRecovered = failedProbe as unknown as () => Promise<boolean>;
    vA.activateProviderFallback(new Date(Date.now() + 1000), 'auth-required');

    await vi.advanceTimersByTimeAsync(60 * 1000 + 1);
    for (let attempt = 2; attempt <= 12; attempt++) {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    }
    expect(getFallbackState(db)?.recoveryState).toBe('terminal');
    expect(getFallbackState(db)?.recoveryTerminalReason).toBe('attempt-limit');

    const runtimeB = makeRuntime(db);
    const vB = fbView(runtimeB);
    const restartProbe = vi.fn(() => false);
    vB.probePrimaryProviderRecovered = restartProbe as unknown as () => Promise<boolean>;
    vB.restorePersistedFallbackWindow();

    expect(vB.effectiveProvider).toBe('opencode-cli');
    expect(vB.getFallbackState().recoveryState).toBe('terminal');
    expect(vB.getFallbackState().recoveryTerminalReason).toBe('attempt-limit');
    await vi.advanceTimersByTimeAsync(3 * 5 * 60 * 1000);
    expect(restartProbe).not.toHaveBeenCalled();
  });

  it('corrupt failed-provider evidence restores to an unavailable no-routing state and blocks a real turn before session creation', async () => {
    const runtimeA = makeRuntime(db);
    fbView(runtimeA).activateProviderFallback(null, 'auth-required');
    const rawEvidence = '{malformed-failed-key-evidence';
    db.raw.prepare(`UPDATE agent_fallback_state SET failed_keys_json = ? WHERE id = 1`).run(rawEvidence);

    const messenger = makeMessenger();
    const runtimeB = makeRuntime(db, messenger);
    const vB = fbView(runtimeB);
    vB.restorePersistedFallbackWindow();

    expect(vB.effectiveProvider).toBe('unavailable');
    expect(vB.getFallbackState().recoveryState).toBe('unavailable');
    expect(vB.getFallbackState().recoveryTerminalReason).toBe('failed-provider-evidence-unavailable');
    const persisted = db.raw.prepare(`SELECT failed_keys_json AS failedKeysJson FROM agent_fallback_state WHERE id = 1`)
      .get() as { failedKeysJson: string };
    expect(persisted.failedKeysJson).toBe(rawEvidence);

    const internals = runtimeB as unknown as {
      ensureSessionAndQueueSync(chatJid: string, mapKey?: string, actorJid?: string): void;
    };
    const ensure = vi.spyOn(internals, 'ensureSessionAndQueueSync').mockImplementation(() => {});
    const blockedTurn: IncomingMessage = {
      messageId: 'corrupt-fallback-evidence-turn',
      chatJid: '15550001111@s.whatsapp.net',
      senderJid: '15550001111@s.whatsapp.net',
      senderName: 'test',
      content: 'route this turn',
      contentText: null,
      contentType: 'text',
      isFromMe: false,
      isGroup: false,
      mentionedJids: [],
      timestamp: Math.floor(Date.now() / 1000),
      quotedMessageId: null,
      isResponseWorthy: true,
    };
    await runtimeB.handleMessage(blockedTurn);

    expect(ensure).not.toHaveBeenCalled();
  });
});
