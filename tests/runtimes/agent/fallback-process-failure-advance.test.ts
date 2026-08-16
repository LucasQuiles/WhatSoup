/**
 * Chain advance on fallback turn PROCESS failure (fleet incident 2026-08-15).
 *
 * A fallback provider whose account is suspended CONNECTS and then exits
 * non-zero on every turn without ever emitting a terminal result. The
 * empty-output advance path (recordFallbackTurnOutcome) never runs because the
 * opencode exit handler discards the buffered result on a non-zero exit — so
 * the chain pinned forever on a dead entry while healthy entries (glm,
 * deepseek) waited behind it, and users saw raw "Agent session ended (exited
 * with code 1)" once per message.
 *
 * These tests pin the fix contract at the runtime layer:
 *   - a non-zero exit of the ACTIVE fallback entry's session during an active
 *     window marks the entry failed and advances the chain to the next
 *     eligible entry (same failedKeys/selection machinery the empty-output and
 *     terminal-failure paths use)
 *   - a managed, plain-language per-chat notice is enqueued (never the raw
 *     exit-code line — suppression is pinned in
 *     fallback-managed-crash-notice.test.ts)
 *   - a replay of the interrupted turn is attempted on the advanced entry when
 *     the pending turn text is still available
 *   - crashes outside a fallback window, or of the PRIMARY provider's session,
 *     change no chain state (the pre-incident crash machinery is untouched)
 *   - a single-entry chain preserves the current entry (no alternate to
 *     advance to) and says so honestly
 *
 * Harness mirrors fallback-severity-downgrade.test.ts (fake timers, mocked
 * emitAlertChecked, deterministic keyring, mocked preflights).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('../../../src/config.ts', () => {
  const config: Record<string, unknown> = {
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full',
    toolUpdateRedirectJid: null,
    textAggregateDelayMs: 2_000,
    mediaDir: '/tmp/whatsoup-test-media-fallback-process-failure/tmp',
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
  (globalThis as Record<string, unknown>)['__processFailureTestConfig__'] = config;
  return { config };
});

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__processFailureTestConfig__'] as Record<string, unknown>;
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
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { emitAlert } from '../../../src/lib/emit-alert.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function makeRuntime(chain: FallbackEntry[]): AgentRuntime {
  const config = mockConfigRef();
  config['agentProvider'] = 'claude-cli';
  config['agentProviderConfig'] = undefined;
  config['agentFallbackProvider'] = undefined;
  config['agentFallbackModel'] = undefined;
  config['agentFallbacks'] = chain;
  return new AgentRuntime(makeDb(), makeMessenger(), 'test', {
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
  stderrPreview?: string;
  sessionId?: string | null;
  dbRowId?: number | null;
  generationIdentity?: { managerId: string; generation: number };
};

type RuntimeView = {
  activateProviderFallback(
    resetAt: Date | null,
    reason?: 'usage-limit' | 'rate-limit' | 'auth-required' | 'model-unavailable' | 'server-error',
  ): unknown;
  handleCrashNotify(msg: string, chatJid?: string, session?: unknown): void;
  replayTurnOnFallback(args: unknown): Promise<void>;
  handlePerChatCrash(mapKey: string, chatJid?: string, info?: CrashInfo): void;
  setOwnedPerChatSession(key: string, session: unknown): void;
  sessionOwnership: {
    get: (key: string) => { managerId: string; generation: number; state: string } | undefined;
  };
  fallbackWindow: { activeUntil: number | null; activeEntry: FallbackEntry | null };
  fallbackChain: { failedKeys: Set<string> };
  chatQueues: Map<string, unknown>;
  pendingTurnText: Map<string, string>;
  pendingTurnActorJid: Map<string, string | undefined>;
  scheduleFallbackReplay(args: unknown): boolean;
  finalizeRuntimeCrash(
    context: unknown,
    queue: unknown,
    session: unknown,
    mapKey?: string,
  ): void;
  runtimeTurnCoordinator: {
    finalizeRuntimeCrash(
      context: unknown,
      queue: unknown,
      session: unknown,
      mapKey?: string,
    ): void;
  };
  perChatRuntimeTurnContexts: Map<string, unknown[]>;
  perChatTurnText: Map<string, string>;
  operationTrackers: Map<string, { shutdown(): void }>;
};

function v(runtime: AgentRuntime): RuntimeView {
  return runtime as unknown as RuntimeView;
}

function alertsFor(source: string): Array<[string, string, string, string, string?]> {
  return vi.mocked(emitAlert).mock.calls.filter((c) => c[1] === source) as Array<
    [string, string, string, string, string?]
  >;
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
  vi.mocked(emitAlert).mockClear();
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

// ─── Chain advance on process failure ─────────────────────────────────────────

describe('fallback chain advance on turn process failure', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T20:00:00Z'));
    vi.mocked(emitAlert).mockClear();
    lookupCredentialMock.mockReturnValue('present-key');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('non-zero exit of the active fallback entry advances the chain to the next entry', () => {
    const runtime = makeRuntime([
      { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
      { provider: 'opencode-cli', model: 'glm/glm-5.2' },
    ]);
    const { rv, owner } = armIncidentShape(runtime);
    expect(rv.fallbackWindow.activeEntry?.model).toBe('kimi/kimi-k3');

    rv.handlePerChatCrash(CHAT, CHAT, crashInfo(owner));

    expect(rv.fallbackWindow.activeEntry?.model).toBe('glm/glm-5.2');
    expect(rv.fallbackChain.failedKeys.size).toBe(1);
    expect(alertsFor('fallback_provider_failed')).toHaveLength(1);
  });

  it('sends a managed per-chat notice naming the dead and replacement models', () => {
    const runtime = makeRuntime([
      { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
      { provider: 'opencode-cli', model: 'glm/glm-5.2' },
    ]);
    const { rv, owner, queue } = armIncidentShape(runtime);

    rv.handlePerChatCrash(CHAT, CHAT, crashInfo(owner));

    expect(queue.enqueueText).toHaveBeenCalledTimes(1);
    const notice = queue.enqueueText.mock.calls[0]![0] as string;
    expect(notice).toContain('kimi/kimi-k3');
    expect(notice).toContain('glm/glm-5.2');
    // Managed copy, never the raw session-crash line.
    expect(notice).not.toContain('Agent session ended');
    expect(notice).not.toContain('exited with code');
  });

  it('attempts a replay of the interrupted turn on the advanced entry when pending turn text exists', () => {
    const runtime = makeRuntime([
      { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
      { provider: 'opencode-cli', model: 'glm/glm-5.2' },
    ]);
    const { rv, owner } = armIncidentShape(runtime);
    rv.pendingTurnText.set(CHAT, 'compare this to our existing tools');
    const replaySpy = vi
      .spyOn(rv as unknown as { scheduleFallbackReplay(args: unknown): boolean }, 'scheduleFallbackReplay')
      .mockReturnValue(true);

    rv.handlePerChatCrash(CHAT, CHAT, crashInfo(owner));

    expect(replaySpy).toHaveBeenCalledTimes(1);
    const args = replaySpy.mock.calls[0]![0] as { chatJid: string; mapKey?: string };
    expect(args.chatJid).toBe(CHAT);
    expect(args.mapKey).toBe(CHAT);
  });

  it('a crash with no fallback window active changes no chain state', () => {
    const runtime = makeRuntime([
      { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
      { provider: 'opencode-cli', model: 'glm/glm-5.2' },
    ]);
    const rv = v(runtime);
    const session = makeFallbackSession('claude-cli', 'claude-opus-4-8');
    rv.setOwnedPerChatSession(CHAT, session);
    const owner = rv.sessionOwnership.get(CHAT)!;
    rv.chatQueues.set(CHAT, makeFakeQueue(CHAT));
    vi.mocked(emitAlert).mockClear();

    rv.handlePerChatCrash(CHAT, CHAT, {
      ...crashInfo(owner),
      provider: 'claude-cli',
    });

    expect(rv.fallbackWindow.activeEntry).toBeNull();
    expect(rv.fallbackChain.failedKeys.size).toBe(0);
    expect(alertsFor('fallback_provider_failed')).toHaveLength(0);
  });

  it('a PRIMARY-provider session crash during an active window does not advance the chain', () => {
    const runtime = makeRuntime([
      { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
      { provider: 'opencode-cli', model: 'glm/glm-5.2' },
    ]);
    const rv = v(runtime);
    rv.activateProviderFallback(null, 'usage-limit');
    const session = makeFallbackSession('claude-cli', 'claude-opus-4-8');
    rv.setOwnedPerChatSession(CHAT, session);
    const owner = rv.sessionOwnership.get(CHAT)!;
    rv.chatQueues.set(CHAT, makeFakeQueue(CHAT));
    vi.mocked(emitAlert).mockClear();

    rv.handlePerChatCrash(CHAT, CHAT, { ...crashInfo(owner), provider: 'claude-cli' });

    expect(rv.fallbackWindow.activeEntry?.model).toBe('kimi/kimi-k3');
    expect(rv.fallbackChain.failedKeys.size).toBe(0);
    expect(alertsFor('fallback_provider_failed')).toHaveLength(0);
  });

  it('single-entry chain: entry is preserved (no alternate) and the notice says so', () => {
    const runtime = makeRuntime([
      { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
    ]);
    const { rv, owner, queue } = armIncidentShape(runtime);

    rv.handlePerChatCrash(CHAT, CHAT, crashInfo(owner));

    // Single-fallback preservation: window keeps the current entry rather than
    // reverting to a known-bad primary; failedKeys stays clear so a later real
    // alternate can still be selected.
    expect(rv.fallbackWindow.activeUntil).not.toBeNull();
    expect(rv.fallbackWindow.activeEntry?.model).toBe('kimi/kimi-k3');
    expect(queue.enqueueText).toHaveBeenCalledTimes(1);
    const notice = queue.enqueueText.mock.calls[0]![0] as string;
    expect(notice).not.toContain('Agent session ended');
  });

  it('advancing twice exhausts a three-entry chain in order', () => {
    const runtime = makeRuntime([
      { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
      { provider: 'opencode-cli', model: 'glm/glm-5.2' },
      { provider: 'opencode-cli', model: 'deepseek/deepseek-v4-pro' },
    ]);
    const { rv, owner } = armIncidentShape(runtime);

    rv.handlePerChatCrash(CHAT, CHAT, crashInfo(owner));
    expect(rv.fallbackWindow.activeEntry?.model).toBe('glm/glm-5.2');

    // Second crash: the replacement session (glm) dies too — rebuild the
    // ownership shape the crash handler expects, then advance again.
    const session2 = makeFallbackSession('opencode-cli', 'glm/glm-5.2');
    rv.setOwnedPerChatSession(`${CHAT}#2`, session2);
    const owner2 = rv.sessionOwnership.get(`${CHAT}#2`)!;
    rv.chatQueues.set(`${CHAT}#2`, makeFakeQueue(CHAT));
    rv.handlePerChatCrash(`${CHAT}#2`, CHAT, crashInfo(owner2));
    expect(rv.fallbackWindow.activeEntry?.model).toBe('deepseek/deepseek-v4-pro');
    expect(rv.fallbackChain.failedKeys.size).toBe(2);
  });
});

// ─── Managed crash notice suppression (raw session-ended line) ────────────────

describe('managed crash notice suppression', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T20:00:00Z'));
    vi.mocked(emitAlert).mockClear();
    lookupCredentialMock.mockReturnValue('present-key');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('suppresses exactly one raw session-ended line after a managed fallback crash', () => {
    const runtime = makeRuntime([
      { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
      { provider: 'opencode-cli', model: 'glm/glm-5.2' },
    ]);
    const { rv, owner, queue, session } = armIncidentShape(runtime);

    rv.handlePerChatCrash(CHAT, CHAT, crashInfo(owner));
    queue.enqueueText.mockClear();

    // The session-layer notifyUnexpectedExit fires right after onCrash — its
    // raw line must be swallowed because the managed notice already went out.
    rv.handleCrashNotify(
      'Agent session ended (exited with code 1). Send any message to start a new session.',
      CHAT,
      session,
    );
    expect(queue.enqueueText).not.toHaveBeenCalled();

    // One-shot: a LATER crash of the same manager without managed handling
    // notifies normally.
    rv.handleCrashNotify(
      'Agent session ended (exited with code 137). Send any message to start a new session.',
      CHAT,
      session,
    );
    expect(queue.enqueueText).toHaveBeenCalledTimes(1);
  });

  it('does not suppress crash notices for sessions with no managed crash', () => {
    const runtime = makeRuntime([
      { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
    ]);
    const rv = v(runtime);
    const session = makeFallbackSession('claude-cli', 'claude-opus-4-8');
    const queue = makeFakeQueue(CHAT);
    rv.chatQueues.set(CHAT, queue);

    rv.handleCrashNotify(
      'Agent session ended (exited with code 1). Send any message to start a new session.',
      CHAT,
      session,
    );
    expect(queue.enqueueText).toHaveBeenCalledTimes(1);
  });
});

// ─── Unjournaled replay failure must notify the user ──────────────────────────

describe('unjournaled fallback replay failure', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T20:00:00Z'));
    vi.mocked(emitAlert).mockClear();
    lookupCredentialMock.mockReturnValue('present-key');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('notifies the user when an unjournaled replay fails with a GENERIC error (not only invalidation)', async () => {
    const runtime = makeRuntime([
      { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
    ]);
    const rv = v(runtime);
    const activation = rv.activateProviderFallback(null, 'usage-limit');
    expect(activation).not.toBeNull();
    const queue = makeFakeQueue(CHAT);
    rv.chatQueues.set(CHAT, queue);
    rv.pendingTurnText.set(CHAT, 'compare this to our existing tools');
    vi.spyOn(
      rv as unknown as { replayTurnOnFallback(args: unknown): Promise<void> },
      'replayTurnOnFallback',
    ).mockRejectedValue(new Error('admission record incomplete — refusing spawn'));

    const scheduled = rv.scheduleFallbackReplay({
      activation,
      chatJid: CHAT,
      mapKey: CHAT,
      oldSession: makeFallbackSession(),
    });
    expect(scheduled).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(queue.enqueueText).toHaveBeenCalledWith(
      expect.stringContaining('backup model could not continue'),
    );
  });
});

// ─── Stale-route crash attribution (live 2026-08-15 round 2) ──────────────────
//
// Chain entries can share one provider and differ only by model. A session
// spawned under a PRIOR entry can still be running when the chain advances
// (another chat's in-flight turn); when that stale session later exits
// non-zero, the failure is evidence against ITS OWN model — not the current
// entry. Live shape: a glm session spawned pre-advance crashed 82s after the
// chain moved to deepseek, provider-only attribution marked never-tried
// deepseek failed, and the chain wrapped back to already-dead kimi.

describe('stale-route session crash attribution', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T20:00:00Z'));
    vi.mocked(emitAlert).mockClear();
    lookupCredentialMock.mockReturnValue('present-key');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a crash of a PRIOR entry\'s still-running session is not charged to the CURRENT entry', () => {
    const runtime = makeRuntime([
      { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
      { provider: 'opencode-cli', model: 'glm/glm-5.2' },
      { provider: 'opencode-cli', model: 'deepseek/deepseek-v4-pro' },
    ]);
    const { rv, owner } = armIncidentShape(runtime);

    // Legitimate advance: the active kimi session crashes → glm.
    rv.handlePerChatCrash(CHAT, CHAT, crashInfo(owner));
    expect(rv.fallbackWindow.activeEntry?.model).toBe('glm/glm-5.2');
    expect(rv.fallbackChain.failedKeys.size).toBe(1);

    // Another chat's session, spawned while kimi was still the active entry,
    // exits non-zero AFTER the advance. Same provider, different model.
    const staleKey = `${CHAT}#stale`;
    const staleSession = makeFallbackSession('opencode-cli', 'kimi/kimi-k3');
    rv.setOwnedPerChatSession(staleKey, staleSession);
    const staleOwner = rv.sessionOwnership.get(staleKey)!;
    rv.chatQueues.set(staleKey, makeFakeQueue(CHAT));
    vi.mocked(emitAlert).mockClear();

    rv.handlePerChatCrash(staleKey, CHAT, crashInfo(staleOwner));

    // glm was never tried — it must remain the active entry, unmarked.
    expect(rv.fallbackWindow.activeEntry?.model).toBe('glm/glm-5.2');
    expect(rv.fallbackChain.failedKeys.size).toBe(1);
    expect(alertsFor('fallback_provider_failed')).toHaveLength(0);
  });
});

// ─── Managed replay must release the crashed physical turn ────────────────────
//
// The dispatch promise of a journaled per-chat turn parks on its runtime
// completion (sendTurnPerChat awaits completion.promise), and the TurnQueue's
// active slot clears only when that promise settles. The terminal-result
// activation path gets the settling finalization from the terminal result
// itself; a process crash has none — so the managed-handoff branch must
// finalize the crashed physical turn when it takes ownership, or the chat
// wedges forever behind it. Live 2026-08-15: every replay session armed with
// message_count=0 and later inbounds queued unserved until a service restart.
// Coordinator-level finalization specifically: the runtime wrapper would
// cancel the replay continuation that scheduleFallbackReplay just claimed.

describe('managed replay releases the crashed physical turn', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T20:00:00Z'));
    vi.mocked(emitAlert).mockClear();
    lookupCredentialMock.mockReturnValue('present-key');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function armWedgeShape() {
    const runtime = makeRuntime([
      { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
      { provider: 'opencode-cli', model: 'glm/glm-5.2' },
    ]);
    const pieces = armIncidentShape(runtime);
    pieces.rv.pendingTurnText.set(CHAT, 'compare this to our existing tools');
    vi.spyOn(
      pieces.rv as unknown as { scheduleFallbackReplay(args: unknown): boolean },
      'scheduleFallbackReplay',
    ).mockReturnValue(true);
    const coordFinalize = vi
      .spyOn(pieces.rv.runtimeTurnCoordinator, 'finalizeRuntimeCrash')
      .mockImplementation(() => {});
    const wrapperFinalize = vi
      .spyOn(pieces.rv as unknown as RuntimeView, 'finalizeRuntimeCrash')
      .mockImplementation(() => {});
    return { ...pieces, coordFinalize, wrapperFinalize };
  }

  it('finalizes the crashed published turn context at the coordinator level, never the continuation-cancelling wrapper', () => {
    const { rv, owner, queue, session, coordFinalize, wrapperFinalize } = armWedgeShape();
    const publishedContext = { identity: { logicalTurnId: 'lt-1' } };
    rv.perChatRuntimeTurnContexts.set(CHAT, [publishedContext]);
    rv.perChatTurnText.set(CHAT, '');
    const tracker = { shutdown: vi.fn() };
    rv.operationTrackers.set(CHAT, tracker);
    const stateBefore = rv.sessionOwnership.get(CHAT)!.state;

    rv.handlePerChatCrash(CHAT, CHAT, crashInfo(owner));

    expect(coordFinalize).toHaveBeenCalledTimes(1);
    expect(coordFinalize).toHaveBeenCalledWith(publishedContext, queue, session, CHAT);
    expect(wrapperFinalize).not.toHaveBeenCalled();
    // Physical-turn state is released; the replay path owns what remains.
    expect(tracker.shutdown).toHaveBeenCalledTimes(1);
    expect(rv.operationTrackers.has(CHAT)).toBe(false);
    expect(rv.perChatTurnText.has(CHAT)).toBe(false);
    // Mirrors the terminal-result path: the manager is discarded by the
    // replay flow, never marked recoverable_dead by the crash machinery.
    expect(rv.sessionOwnership.get(CHAT)!.state).toBe(stateBefore);
  });

  it('finalizes with an undefined context when the crashed turn was unjournaled so queue evidence still aborts', () => {
    const { rv, owner, queue, session, coordFinalize } = armWedgeShape();

    rv.handlePerChatCrash(CHAT, CHAT, crashInfo(owner));

    expect(coordFinalize).toHaveBeenCalledTimes(1);
    expect(coordFinalize).toHaveBeenCalledWith(undefined, queue, session, CHAT);
  });
});
