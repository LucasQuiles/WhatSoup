/**
 * FALLBACK-tier failures must not move the fallback window's clocks.
 *
 * Live defect (ph-bot 2026-08-26): a FALLBACK-tier turn failure re-enters the
 * fallback activation path (recordFallbackTurnProcessFailure, and the
 * empty-advance path in recordFallbackTurnOutcome), which — with a null
 * resetAt — (a) extends fallbackWindow.activeUntil by up to
 * DEFAULT_FALLBACK_WINDOW_MS via the extend-never-shorten Math.max in
 * activateProviderFallback, and (b) re-arms armFallbackWindow's clocks,
 * restarting the standing 5-minute primary recovery probe countdown
 * (scheduleFallbackPrimaryProbe). A dead fallback tier plus live user traffic
 * therefore postpones primary recovery indefinitely: every failed fallback
 * turn pushes both the window end and the next probe out again.
 *
 * Contract pinned here:
 *   - a fallback-tier failure with null resetAt advances the chain exactly as
 *     today but leaves activeUntil numerically unchanged, keeps the standing
 *     primary-probe deadline, and does not re-arm the revert timer to a later
 *     deadline — via BOTH the process-failure path and the empty-advance path,
 *     and under repeated failures
 *   - PRIMARY-tier failures keep the existing extend + probe-restart behavior
 *     (regression pin)
 *   - the persisted-window restore path still arms both clocks fresh
 *
 * Harness mirrors fallback-process-failure-advance.test.ts (fake timers,
 * mocked emitAlertChecked, deterministic keyring, mocked preflights) with the
 * instance-level probePrimaryProviderRecovered stub from
 * fallback-probe-stall.test.ts and the real-SQLite restore shape from
 * fallback-persistence-integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

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

vi.mock('../../../src/config.ts', () => {
  const config: Record<string, unknown> = {
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full',
    toolUpdateRedirectJid: null,
    textAggregateDelayMs: 2_000,
    mediaDir: '/tmp/whatsoup-test-media-fallback-tier-clock/tmp',
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
    agentFallbackProvider: undefined,
    agentFallbackModel: undefined,
    agentFallbacks: undefined,
  };
  (globalThis as Record<string, unknown>)['__tierClockTestConfig__'] = config;
  return { config };
});

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__tierClockTestConfig__'] as Record<string, unknown>;
}

vi.mock('../../../src/mcp/register-all.ts', () => ({
  registerAllTools: vi.fn(),
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

const lookupCredentialMock = vi.fn<(service: string) => string | null>(() => 'present-key');
vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...actual,
    lookupCredential: (service: string) => lookupCredentialMock(service),
  };
});

vi.mock('../../../src/runtimes/agent/providers/credential-verify.ts', () => ({
  verifyFallbackCredential: vi.fn(() => Promise.resolve('unknown')),
}));
vi.mock('../../../src/runtimes/agent/providers/binary-preflight.ts', () => ({
  probeFallbackBinary: vi.fn(() => Promise.resolve({ status: 'unknown', version: null })),
  probeModelCatalog: vi.fn(() => Promise.resolve({ status: 'unknown', suggestion: null })),
}));

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { ensureFallbackStateSchema } from '../../../src/runtimes/agent/fallback-state-db.ts';
import { DEFAULT_FALLBACK_WINDOW_MS } from '../../../src/runtimes/agent/runtime-tunables.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const RECHECK_MS = 300_000; // fallbackTunables.primaryRecheckMs above

function makeDb(): Database {
  return {
    assertWritableCompatibility: vi.fn(),
    raw: {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })),
      exec: vi.fn(),
    },
  } as unknown as Database;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

interface FallbackEntry {
  provider: string;
  model?: string;
}

function makeRuntime(chain: FallbackEntry[], db: Database = makeDb()): AgentRuntime {
  const config = mockConfigRef();
  config['agentProvider'] = 'claude-cli';
  config['agentProviderConfig'] = undefined;
  config['agentFallbackProvider'] = undefined;
  config['agentFallbackModel'] = undefined;
  config['agentFallbacks'] = chain;
  return new AgentRuntime(db, makeMessenger(), 'test', {
    model: 'claude-opus-4-8[1m]',
    sessionScope: 'per_chat',
  });
}

function makeFakeQueue(chatJid: string) {
  return {
    targetChatJid: chatJid,
    enqueueText: vi.fn(),
    getSenderToken: () => 'mock-sender-token',
    enqueueResultText: vi.fn(),
    enqueueStreamingText: vi.fn(),
    enqueueToolUpdate: vi.fn(),
    markLastTerminal: vi.fn(),
    flush: vi.fn(async () => {}),
    getLastOpId: vi.fn(() => undefined),
    clearLastOpId: vi.fn(),
    indicateTyping: vi.fn(),
    endTurn: vi.fn(),
    abortTurn: vi.fn(),
    updateDeliveryJid: vi.fn(),
  };
}

/** Fake per-chat SessionManager serving the active fallback entry. */
function makeFallbackSession(provider = 'opencode-cli', model = 'kimi/kimi-k3') {
  return {
    bindGenerationOwnership: vi.fn(),
    getStatus: vi.fn(() => ({ active: true, sessionId: null, pid: null })),
    getDbRowId: vi.fn(() => null),
    getProviderId: vi.fn(() => provider),
    getModelRef: vi.fn(() => model),
    shutdown: vi.fn(async () => {}),
  };
}

type CrashInfo = {
  exitCode?: number | null;
  signal?: string | null;
  provider?: string;
  crashClass?: string;
  sessionId?: string | null;
  dbRowId?: number | null;
  generationIdentity?: { managerId: string; generation: number };
};

type RuntimeView = {
  activateProviderFallback(
    resetAt: Date | null,
    reason?: 'usage-limit' | 'rate-limit' | 'auth-required' | 'model-unavailable' | 'server-error',
  ): unknown;
  handlePerChatCrash(mapKey: string, chatJid?: string, info?: CrashInfo): void;
  setOwnedPerChatSession(key: string, session: unknown): void;
  sessionOwnership: {
    get: (key: string) => { managerId: string; generation: number; state: string } | undefined;
  };
  fallbackWindow: { activeUntil: number | null; activeEntry: FallbackEntry | null };
  fallbackChain: { failedKeys: Set<string> };
  chatQueues: Map<string, unknown>;
  recordFallbackTurnOutcome(
    queue: unknown,
    hadVisibleOutput: boolean,
    hadToolWork: boolean,
    session: unknown,
    wasUnclassifiedError?: boolean,
  ): void;
  probePrimaryProviderRecovered(): boolean | Promise<boolean>;
  restorePersistedFallbackWindow(): void;
  effectiveProvider: string;
};

function v(runtime: AgentRuntime): RuntimeView {
  return runtime as unknown as RuntimeView;
}

const CHAT = 'chat@s.whatsapp.net';

/** Arm the window, map a fake fallback session + queue, return the pieces. */
function armIncidentShape(runtime: AgentRuntime, opts: { model?: string } = {}) {
  const rv = v(runtime);
  const activation = rv.activateProviderFallback(null, 'usage-limit');
  expect(activation).not.toBeNull();
  const session = makeFallbackSession('opencode-cli', opts.model ?? 'kimi/kimi-k3');
  rv.setOwnedPerChatSession(CHAT, session);
  const owner = rv.sessionOwnership.get(CHAT);
  if (!owner) throw new Error('missing owned session');
  const queue = makeFakeQueue(CHAT);
  rv.chatQueues.set(CHAT, queue);
  return { rv, session, owner, queue };
}

function crashInfo(owner: { managerId: string; generation: number }): CrashInfo {
  return {
    exitCode: 1,
    signal: null,
    provider: 'opencode-cli',
    crashClass: 'unknown_terminal',
    sessionId: null,
    dbRowId: null,
    generationIdentity: { managerId: owner.managerId, generation: owner.generation },
  };
}

/** Session shape the empty-advance attribution gate matches (mirrors
 *  fallback-empty-turn.test.ts — provider id only, no model ref). */
const ocSession = {
  getProviderId: () => 'opencode-cli',
  getStatus: () => ({ sessionId: 'opencode-cli-1' }),
};

const TWO_ENTRY_CHAIN: FallbackEntry[] = [
  { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
  { provider: 'opencode-cli', model: 'glm/glm-5.2' },
];

// ─── Fallback-tier failures must not move the window clocks ───────────────────

describe('fallback-tier failure clock preservation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T20:00:00Z'));
    lookupCredentialMock.mockReturnValue('present-key');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) a fallback-tier process failure with null resetAt leaves activeUntil numerically unchanged while still advancing the chain', async () => {
    const runtime = makeRuntime(TWO_ENTRY_CHAIN);
    const { rv, owner } = armIncidentShape(runtime);
    const armedUntil = rv.fallbackWindow.activeUntil;
    expect(armedUntil).toBe(Date.now() + DEFAULT_FALLBACK_WINDOW_MS);

    // Live user traffic two minutes into the window, then the fallback
    // entry's turn process exits non-zero.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    rv.handlePerChatCrash(CHAT, CHAT, crashInfo(owner));

    // Chain advance is preserved exactly as today...
    expect(rv.fallbackWindow.activeEntry?.model).toBe('glm/glm-5.2');
    // ...but the window end must not move: the failure is evidence about the
    // FALLBACK entry, not about the primary.
    expect(rv.fallbackWindow.activeUntil).toBe(armedUntil);
  });

  it('(a) a fallback-tier process failure does not restart the standing primary recovery probe countdown', async () => {
    const runtime = makeRuntime(TWO_ENTRY_CHAIN);
    const { rv, owner } = armIncidentShape(runtime);
    const probe = vi.fn(() => false);
    rv.probePrimaryProviderRecovered = probe as unknown as () => boolean;

    // The standing probe was armed at activation: due at T0 + RECHECK_MS.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    rv.handlePerChatCrash(CHAT, CHAT, crashInfo(owner));
    expect(probe).not.toHaveBeenCalled();

    // Three more minutes reach the ORIGINAL deadline. A restarted countdown
    // (the defect) would not fire until T0 + 7 min.
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('(b) the empty-advance path preserves the window end and probe deadline while advancing the chain', async () => {
    const runtime = makeRuntime([
      { provider: 'opencode-cli', model: 'minimax/MiniMax-M2.7' },
      { provider: 'opencode-cli', model: 'deepseek/deepseek-chat' },
    ]);
    const rv = v(runtime);
    expect(rv.activateProviderFallback(null, 'usage-limit')).not.toBeNull();
    const probe = vi.fn(() => false);
    rv.probePrimaryProviderRecovered = probe as unknown as () => boolean;
    const armedUntil = rv.fallbackWindow.activeUntil;
    const queue = makeFakeQueue(CHAT);

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    // Two consecutive structurally-empty fallback turns reach the advance
    // threshold and route through the terminal advance path.
    rv.recordFallbackTurnOutcome(queue, false, false, ocSession);
    rv.recordFallbackTurnOutcome(queue, false, false, ocSession);

    expect(rv.fallbackWindow.activeEntry?.model).toBe('deepseek/deepseek-chat');
    expect(rv.fallbackWindow.activeUntil).toBe(armedUntil);
    expect(probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('(c) repeated fallback-tier failures under simulated traffic never move the window end or the probe deadline', async () => {
    const runtime = makeRuntime([
      { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
      { provider: 'opencode-cli', model: 'glm/glm-5.2' },
      { provider: 'opencode-cli', model: 'deepseek/deepseek-v4-pro' },
    ]);
    const { rv, owner } = armIncidentShape(runtime);
    const probe = vi.fn(() => false);
    rv.probePrimaryProviderRecovered = probe as unknown as () => boolean;
    const armedUntil = rv.fallbackWindow.activeUntil;

    // Minute 1: the active kimi session's turn process dies.
    await vi.advanceTimersByTimeAsync(60 * 1000);
    rv.handlePerChatCrash(CHAT, CHAT, crashInfo(owner));
    expect(rv.fallbackWindow.activeEntry?.model).toBe('glm/glm-5.2');
    expect(rv.fallbackWindow.activeUntil).toBe(armedUntil);

    // Minute 2: the replacement glm session dies too.
    const session2 = makeFallbackSession('opencode-cli', 'glm/glm-5.2');
    rv.setOwnedPerChatSession(`${CHAT}#2`, session2);
    const owner2 = rv.sessionOwnership.get(`${CHAT}#2`)!;
    rv.chatQueues.set(`${CHAT}#2`, makeFakeQueue(CHAT));
    await vi.advanceTimersByTimeAsync(60 * 1000);
    rv.handlePerChatCrash(`${CHAT}#2`, CHAT, crashInfo(owner2));
    expect(rv.fallbackWindow.activeEntry?.model).toBe('deepseek/deepseek-v4-pro');
    expect(rv.fallbackWindow.activeUntil).toBe(armedUntil);

    // The standing probe still fires at the ORIGINAL T0 + RECHECK_MS deadline.
    expect(probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RECHECK_MS - 2 * 60 * 1000);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('(d) the fallback chain still advances to the next entry on a fallback-tier failure', () => {
    const runtime = makeRuntime(TWO_ENTRY_CHAIN);
    const { rv, owner } = armIncidentShape(runtime);

    rv.handlePerChatCrash(CHAT, CHAT, crashInfo(owner));

    expect(rv.fallbackWindow.activeEntry?.model).toBe('glm/glm-5.2');
    expect(rv.fallbackChain.failedKeys.size).toBe(1);
    expect(rv.fallbackWindow.activeUntil).not.toBeNull();
  });

  it('(e) a PRIMARY-tier failure with null resetAt still extends the window and restarts the probe countdown (regression pin)', async () => {
    const runtime = makeRuntime(TWO_ENTRY_CHAIN);
    const rv = v(runtime);
    expect(rv.activateProviderFallback(null, 'usage-limit')).not.toBeNull();
    const probe = vi.fn(() => false);
    rv.probePrimaryProviderRecovered = probe as unknown as () => boolean;
    const armedUntil = rv.fallbackWindow.activeUntil!;

    // Two minutes later the PRIMARY fails again: extend-never-shorten moves
    // the window end out and re-arms the probe countdown — unchanged behavior.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(rv.activateProviderFallback(null, 'usage-limit')).not.toBeNull();
    expect(rv.fallbackWindow.activeUntil).toBe(armedUntil + 2 * 60 * 1000);

    // The probe countdown restarted at the extension: nothing at the original
    // T0 + 5 min deadline, one probe at T0 + 7 min.
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('(f) the persisted-window restore path still arms the revert timer and the standing probe fresh', async () => {
    const dbPath = join(tmpdir(), `whatsoup-tier-clock-test-${randomBytes(4).toString('hex')}.db`);
    const db = new Database(dbPath);
    db.open();
    try {
      ensureFallbackStateSchema(db);

      // Runtime A activates and persists a usage-limit window.
      const runtimeA = makeRuntime(TWO_ENTRY_CHAIN, db);
      const vA = v(runtimeA);
      vA.probePrimaryProviderRecovered = vi.fn(() => false) as unknown as () => boolean;
      expect(vA.activateProviderFallback(null, 'usage-limit')).not.toBeNull();
      const persistedUntil = vA.fallbackWindow.activeUntil!;

      // Runtime B (the restarted process) restores it: same window end, and
      // the standing probe is armed fresh from the restore instant.
      const runtimeB = makeRuntime(TWO_ENTRY_CHAIN, db);
      const vB = v(runtimeB);
      const probe = vi.fn(() => false);
      vB.probePrimaryProviderRecovered = probe as unknown as () => boolean;
      vB.restorePersistedFallbackWindow();
      expect(vB.effectiveProvider).toBe('opencode-cli');
      expect(vB.fallbackWindow.activeUntil).toBe(persistedUntil);

      await vi.advanceTimersByTimeAsync(RECHECK_MS);
      expect(probe).toHaveBeenCalledTimes(1);
    } finally {
      try { db.close(); } catch { /* best-effort */ }
      for (const suffix of ['', '-wal', '-shm']) {
        const fp = dbPath + suffix;
        if (existsSync(fp)) unlinkSync(fp);
      }
    }
  });
});
