// #2976 direction (ii) — per-turn read-time actor scoping for the GLOBAL socket.
//
// The defect: single/shared scope BROADCAST each inbound WhatsApp sender onto
// the global socket's base session and every live connection
// (updateActorJid), and nothing ever cleared it — a same-UID operator client
// could inherit admin identity indefinitely after the last message.
//
// The fix (owner-ruled direction ii): the broadcast is DELETED; the global
// socket instead carries a read-time actorResolver backed by an
// executing-turn register (the QR-247 per-chat template, reusing the same
// perChatExecActorQueue machinery under GLOBAL_CONVERSATION_KEY). Polarity
// inverts: no turn executing → resolver returns undefined → fail-closed deny.
// A missed cleanup DENIES instead of allowing.
//
// Harness: REAL AgentRuntime + REAL coordinator; provider boundary faked
// (scheduled-turn-lifecycle pattern); the socket-server module mock captures
// constructor args so tests can drive the captured resolver directly.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Messenger, IncomingMessage } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import { toConversationKey } from '../../../src/core/conversation-key.ts';

// ─── Hoisted provider-boundary doubles ──────────────────────────────────────

const { sessionDoubles, queueDoubles, resetDoubles, makeSessionDouble, makeQueueDouble, socketServers } = vi.hoisted(() => {
  type SessionCtorOpts = {
    chatJid: string;
    persistenceConversationKey?: string;
    onEvent: (event: AgentEvent) => void;
    onCrash?: (info: unknown) => void;
    notifyUser?: (msg: string) => void;
  };

  function makeSessionDouble(opts: SessionCtorOpts) {
    let active = false;
    let pendingResolve: (() => void) | null = null;
    let pendingPromise: Promise<void> = Promise.resolve();
    const double = {
      ctorOpts: opts,
      turnsSent: [] as unknown[],
      get turnInFlight(): boolean {
        return pendingResolve !== null;
      },
      emit(event: AgentEvent): void {
        opts.onEvent(event);
      },
      spawnSession: vi.fn(async () => {
        active = true;
      }),
      sendTurn: vi.fn((input: unknown) => {
        double.turnsSent.push(input);
        pendingPromise = new Promise<void>((resolve) => {
          pendingResolve = resolve;
        });
        return pendingPromise;
      }),
      completeProviderTurn: vi.fn(() => {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve?.();
      }),
      waitForProviderTurnToTerminalize: vi.fn(() => pendingPromise),
      handleNew: vi.fn(async () => {}),
      getStatus: vi.fn(() => ({
        active,
        pid: active ? 4242 : null,
        sessionId: active ? 'sess-test' : null,
        startedAt: active ? new Date().toISOString() : null,
        messageCount: 0,
        lastMessageAt: null as string | null,
        turnInFlight: pendingResolve !== null,
      })),
      shutdown: vi.fn(async () => {
        active = false;
      }),
      clearTurnWatchdog: vi.fn(),
      tickWatchdog: vi.fn(),
      trackToolStart: vi.fn(),
      trackToolEnd: vi.fn(),
      getDbRowId: vi.fn((): number | null => 1),
      setDurability: vi.fn(),
      bindGenerationOwnership: vi.fn(),
      getProviderId: vi.fn(() => 'claude-cli'),
      getModelRef: vi.fn(() => undefined),
    };
    return double;
  }

  function makeQueueDouble(chatJid: string, conversationKey: string) {
    void conversationKey;
    const double = {
      targetChatJid: chatJid,
      enqueueText: vi.fn(),
      getSenderToken: () => 'test-sender-token',
      enqueueStreamingText: vi.fn(),
      commitStreamingText: vi.fn(),
      discardPreToolAssistantText: vi.fn(),
      enqueueResultText: vi.fn(),
      enqueueToolUpdate: vi.fn(),
      enqueueProgressUpdate: vi.fn(),
      indicateTyping: vi.fn(),
      flush: vi.fn(async () => {}),
      isPoisoned: vi.fn(() => false),
      shutdown: vi.fn(async () => {}),
      abortTurn: vi.fn(),
      updateDeliveryJid: vi.fn(),
      setInboundSeq: vi.fn(),
      markLastTerminal: vi.fn(),
      clearLastOpId: vi.fn(),
      beginTurnEvidence: vi.fn(),
      flushTurnEvidence: vi.fn(async (turnId: string) => ({
        turnId,
        answerOpIds: [],
        lifecycleOpIds: [],
        statusOpIds: [],
      })),
      setToolUpdateMode: vi.fn(),
      setToolUpdateRedirectJid: vi.fn(),
      setTextAggregateDelayMs: vi.fn(),
      enqueuePoll: vi.fn(async (fn: () => Promise<void>) => {
        await fn();
      }),
      hasPendingPoll: vi.fn(() => false),
      setPollPending: vi.fn(),
      endTurn: vi.fn(),
      getLastOpId: vi.fn(() => undefined),
      setDurability: vi.fn(),
    };
    return double;
  }

  const sessionDoubles: Array<ReturnType<typeof makeSessionDouble>> = [];
  const queueDoubles: Array<ReturnType<typeof makeQueueDouble>> = [];
  /** Every WhatSoupSocketServer construction: tier + captured resolver + spies. */
  const socketServers: Array<{
    session: { tier?: string };
    executingSessionResolver: (() => {
      actorJid?: string;
      purpose?: string;
      conversationKey?: string;
    }) | undefined;
    updateActorJid: ReturnType<typeof vi.fn>;
  }> = [];

  function resetDoubles(): void {
    sessionDoubles.length = 0;
    queueDoubles.length = 0;
    socketServers.length = 0;
  }

  return { sessionDoubles, queueDoubles, resetDoubles, makeSessionDouble, makeQueueDouble, socketServers };
});

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set<string>(['15550001']),
    controlPeers: new Map<string, string>(),
    internalPeerJids: new Set<string>(),
    toolUpdateMode: 'full' as const,
    toolUpdateRedirectJid: null as string | null,
    textAggregateDelayMs: 2_000,
    stateRoot: `/tmp/whatsoup-test-state-actor-scoping-${process.pid}`,
    restartLoopGuard: { enabled: true, maxRestarts: 3, windowMs: 300_000 },
    startupNotifications: false,
    proactiveResumeOnStartup: false,
    mediaDir: `/tmp/whatsoup-test-media-actor-scoping-${process.pid}`,
    pineconeAllowedIndexes: [] as string[],
    voiceReply: 'never' as const,
    elevenlabs: { defaultVoiceId: 'v', defaultModel: 'm', stability: 0.5, similarityBoost: 0.75 },
    memory: { adminJid: 'admin@s.whatsapp.net' },
  },
}));

// ─── Module mocks ───────────────────────────────────────────────────────────

vi.mock('../../../src/logger.ts', async () => {
  const { loggerMock } = await import('../../helpers/logger-mock.ts');
  return loggerMock();
});

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlert: vi.fn(),
  emitAlertChecked: vi.fn(),
  emitObservationChecked: vi.fn(() => true),
  clearAlertSource: vi.fn(),
  clearAlertSourceChecked: vi.fn(),
}));

vi.mock('../../../src/core/messages.ts', () => ({
  getRecentMessages: vi.fn(() => []),
  getMessagesSince: vi.fn(() => []),
  updateMediaPath: vi.fn(),
  updateTranscription: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/media-prep.ts', () => ({
  prepareContentForAgent: vi.fn(async (msg: IncomingMessage) => msg.content ?? ''),
  relocateMediaToWorkspace: vi.fn((content: string) => content),
}));

vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  ensureAgentSchema: vi.fn(),
  createSession: vi.fn(() => 1),
  accumulateSessionTokens: vi.fn(),
  incrementMessageCount: vi.fn(),
  updateSessionId: vi.fn(),
  updateSessionStatus: vi.fn(),
  getActiveSession: vi.fn(() => null),
  backfillWorkspaceKeys: vi.fn(),
  markOrphaned: vi.fn(),
  getResumableSessionForChat: vi.fn(() => null),
  backfillSessionProvider: vi.fn(),
  accumulateTokensWithEvent: vi.fn(),
  insertTokenEvent: vi.fn(),
  getSessionTokenSnapshot: vi.fn(() => null),
  markSessionCompacted: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/session-classifier.ts', () => ({
  classifyActiveSessions: vi.fn(() => []),
}));

vi.mock('../../../src/runtimes/agent/session.ts', () => ({
  // eslint-disable-next-line prefer-arrow-callback -- constructor mock requires function keyword; expires 2026-12-31
  SessionManager: vi.fn().mockImplementation(function (opts: {
    chatJid: string;
    persistenceConversationKey?: string;
    onEvent: (event: AgentEvent) => void;
  }) {
    const double = makeSessionDouble(opts);
    sessionDoubles.push(double);
    return double;
  }),
  formatAge: vi.fn(() => 'now'),
  getProviderBinary: vi.fn(() => null),
}));

vi.mock('../../../src/runtimes/agent/outbound-queue.ts', () => ({
  // eslint-disable-next-line prefer-arrow-callback -- constructor mock requires function keyword; expires 2026-12-31
  OutboundQueue: vi.fn().mockImplementation(function (
    _messenger: unknown,
    chatJid: string,
    opts?: { conversationKey?: string },
  ) {
    const double = makeQueueDouble(chatJid, opts?.conversationKey ?? chatJid.replace(/@.*$/, ''));
    queueDoubles.push(double);
    return double;
  }),
}));

vi.mock('../../../src/config.ts', () => ({ config: mockConfig }));

vi.mock('../../../src/core/workspace.ts', () => ({
  chatJidToWorkspace: vi.fn((_cwd: string, chatJid: string) => {
    const key = chatJid.replace(/@.*$/, '');
    return {
      kind: chatJid.endsWith('@g.us') ? ('group' as const) : ('dm' as const),
      workspaceKey: key,
      workspacePath: `/tmp/whatsoup-test-ws-${key}`,
    };
  }),
  provisionWorkspace: vi.fn(() => '/tmp/whatsoup-test-ws/.claude/whatsoup.sock'),
  writeSandboxArtifacts: vi.fn(),
  ensurePermissionsSettings: vi.fn(),
  writePrivateFileSync: vi.fn(),
}));

vi.mock('../../../src/mcp/socket-server.ts', () => ({
  // eslint-disable-next-line prefer-arrow-callback -- constructor mock requires function keyword; expires 2026-12-31
  WhatSoupSocketServer: vi.fn().mockImplementation(function (
    _socketPath: string,
    _registry: unknown,
    session: { tier?: string },
    executingSessionResolver?: () => {
      actorJid?: string;
      purpose?: string;
      conversationKey?: string;
    },
  ) {
    const instance = {
      session,
      executingSessionResolver,
      start: vi.fn(),
      stop: vi.fn(),
      updateDeliveryJid: vi.fn(),
      updateActorJid: vi.fn(),
      updateConversationKey: vi.fn(),
    };
    socketServers.push(instance as unknown as (typeof socketServers)[number]);
    return instance;
  }),
}));

vi.mock('../../../src/mcp/register-all.ts', () => ({
  registerAllTools: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/media-bridge.ts', () => ({
  startMediaBridge: vi.fn(() => null),
  setMediaBridgeChat: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

// ─── Imports under test (after mocks) ───────────────────────────────────────

import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import { AgentRuntime, type AgentRuntimeOptions } from '../../../src/runtimes/agent/runtime.ts';
import { installFakePerChatMcpSocketManager } from './helpers/fake-per-chat-mcp-socket-manager.ts';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const chatJid = '15550002@s.whatsapp.net';
const senderJid = '15550001@s.whatsapp.net';

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: `msg-actor-${Math.random().toString(36).slice(2, 8)}`,
    chatJid,
    senderJid,
    senderName: 'Test User',
    content: 'operator scoping question',
    contentText: null,
    contentType: 'text',
    isFromMe: false,
    isGroup: false,
    mentionedJids: [],
    timestamp: Date.now(),
    quotedMessageId: null,
    isResponseWorthy: true,
    ...overrides,
  };
}

function turnText(input: unknown): string {
  if (typeof input === 'string') return input;
  const structured = input as { userText?: string; applicationContext?: readonly string[] };
  return [structured.applicationContext?.join('\n') ?? '', structured.userText ?? ''].join('\n');
}

type SessionDouble = (typeof sessionDoubles)[number];

async function waitForInFlightTurn(matcher: (text: string) => boolean, timeout = 4_000): Promise<SessionDouble> {
  let found: SessionDouble | undefined;
  await vi.waitFor(() => {
    found = sessionDoubles.find(
      (s) => s.turnInFlight && s.turnsSent.some((t) => matcher(turnText(t))),
    );
    expect(found).toBeDefined();
  }, { timeout });
  return found!;
}

describe('global-socket actor scoping (#2976 direction ii)', () => {
  let db: Database;
  let engine: DurabilityEngine;
  let runtime: AgentRuntime;

  function globalSocket() {
    const server = socketServers.find((s) => s.session?.tier === 'global');
    expect(server).toBeDefined();
    return server!;
  }

  function workspaceSocket() {
    const server = socketServers.find((s) => s.session?.tier === 'chat-scoped');
    expect(server).toBeDefined();
    return server!;
  }

  function makeRuntime(options: AgentRuntimeOptions): void {
    runtime = new AgentRuntime(db, makeMessenger(), 'test', options);
    installFakePerChatMcpSocketManager(runtime);
    runtime.setDurability(engine);
  }

  async function arriveMessage(overrides: Partial<IncomingMessage> = {}): Promise<number> {
    const messageId = (overrides.messageId as string | undefined) ?? `msg-actor-${Date.now()}`;
    const targetJid = (overrides.chatJid as string | undefined) ?? chatJid;
    const seq = engine.journalInbound(messageId, toConversationKey(targetJid), targetJid, 'agent');
    void runtime.handleMessage(makeMsg({ ...overrides, messageId, chatJid: targetJid, inboundSeq: seq }));
    return seq;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetDoubles();
    db = new Database(':memory:');
    db.open();
    engine = new DurabilityEngine(db);
  });

  afterEach(async () => {
    for (const session of sessionDoubles) {
      if (session.turnInFlight) session.emit({ type: 'result', text: 'late' });
    }
    await runtime?.shutdown();
    db.close();
  });

  it('shared scope: an inbound sender is never broadcast onto the global socket', async () => {
    makeRuntime({ sessionScope: 'shared' });
    await runtime.start();

    await arriveMessage();
    const session = await waitForInFlightTurn((t) => t.includes('operator scoping question'));
    session.emit({ type: 'result', text: 'done' });
    await (runtime as unknown as { turnChain: Promise<void> }).turnChain;

    // The stale-broadcast surface is gone: nothing writes the sender into the
    // socket's base session or its live connections.
    expect(globalSocket().updateActorJid).not.toHaveBeenCalled();
  });

  it('shared scope: the read-time resolver exposes the sender only WHILE its turn executes, then fails closed', async () => {
    makeRuntime({ sessionScope: 'shared' });
    await runtime.start();

    const resolver = globalSocket().executingSessionResolver;
    expect(resolver).toBeDefined();
    // Before any turn: deny.
    expect(resolver!()).toEqual({
      actorJid: undefined,
      purpose: undefined,
      conversationKey: undefined,
    });

    await arriveMessage();
    const session = await waitForInFlightTurn((t) => t.includes('operator scoping question'));
    // Mid-turn: the executing turn's sender resolves.
    expect(resolver!()).toEqual({
      actorJid: senderJid,
      purpose: undefined,
      conversationKey: toConversationKey(chatJid),
    });

    session.emit({ type: 'result', text: 'done' });
    await (runtime as unknown as { turnChain: Promise<void> }).turnChain;
    // Between turns: deny again — a missed cleanup would DENY, never allow.
    await vi.waitFor(() => {
      expect(resolver!()).toEqual({
        actorJid: undefined,
        purpose: undefined,
        conversationKey: undefined,
      });
    }, { timeout: 4_000 });
  });

  it('per_chat (non-sandbox): the global socket resolver never exposes a per-chat sender', async () => {
    makeRuntime({ sessionScope: 'per_chat' });
    await runtime.start();

    const resolver = globalSocket().executingSessionResolver;
    expect(resolver).toBeDefined();

    await arriveMessage();
    await waitForInFlightTurn((t) => t.includes('operator scoping question'));
    // The per-chat sender rides its own actor-bound socket; the shared global
    // socket stays actor-less for the whole mode.
    expect(resolver!()).toEqual({
      actorJid: undefined,
      purpose: undefined,
      conversationKey: undefined,
    });
  });

  it('sandboxPerChat: the workspace socket resolves the scheduled turn actor and purpose at request time', async () => {
    makeRuntime({ sessionScope: 'per_chat', sandboxPerChat: true });
    await runtime.start();

    await arriveMessage({ content: 'scheduled workspace turn', isSyntheticJob: true });
    const session = await waitForInFlightTurn((text) => text.includes('scheduled workspace turn'));
    const resolver = workspaceSocket().executingSessionResolver;
    expect(resolver).toBeDefined();
    expect(resolver!()).toEqual({
      actorJid: senderJid,
      purpose: 'scheduled-agent-job',
      conversationKey: toConversationKey(chatJid),
    });

    session.emit({ type: 'result', text: 'done' });
    await (runtime as unknown as { turnChain: Promise<void> }).turnChain;
    await vi.waitFor(() => {
      expect(resolver!()).toEqual({
        actorJid: undefined,
        purpose: undefined,
        conversationKey: undefined,
      });
    }, { timeout: 4_000 });
  });
});
