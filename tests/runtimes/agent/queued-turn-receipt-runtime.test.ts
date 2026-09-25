// #2949 first slice (owner decision 63): the queued receipt, wired end to end.
//
// Harness: REAL AgentRuntime + REAL RuntimeTurnCoordinator + REAL per-chat
// TurnQueue + REAL SQLite DurabilityEngine. Only the provider session and the
// per-turn OutboundQueue are doubles (deferred-turn-admission.test.ts pattern).
// Because the per-turn OutboundQueue is a double, `messenger.sendMessage` is
// reached only by out-of-band sends, which is what the receipt must be: it must
// never ride the active turn's outbound queue, where it would count as that
// turn's visible answer.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Messenger, IncomingMessage } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import { toConversationKey } from '../../../src/core/conversation-key.ts';
import type { TurnQueue } from '../../../src/runtimes/agent/turn-queue.ts';

const { sessionDoubles, queueDoubles, resetDoubles, makeSessionDouble, makeQueueDouble } = vi.hoisted(() => {
  type SessionCtorOpts = {
    chatJid: string;
    persistenceConversationKey?: string;
    onEvent: (event: AgentEvent) => void;
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

  function makeQueueDouble(chatJid: string) {
    return {
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
  }

  const sessionDoubles: Array<ReturnType<typeof makeSessionDouble>> = [];
  const queueDoubles: Array<ReturnType<typeof makeQueueDouble>> = [];

  function resetDoubles(): void {
    sessionDoubles.length = 0;
    queueDoubles.length = 0;
  }

  return { sessionDoubles, queueDoubles, resetDoubles, makeSessionDouble, makeQueueDouble };
});

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    queuedTurnReceipt: true,
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set<string>(['15550001']),
    controlPeers: new Map<string, string>(),
    internalPeerJids: new Set<string>(),
    toolUpdateMode: 'full' as const,
    toolUpdateRedirectJid: null as string | null,
    textAggregateDelayMs: 2_000,
    stateRoot: `/tmp/whatsoup-test-state-queued-receipt-${process.pid}`,
    restartLoopGuard: { enabled: true, maxRestarts: 3, windowMs: 300_000 },
    startupNotifications: false,
    proactiveResumeOnStartup: false,
    mediaDir: `/tmp/whatsoup-test-media-queued-receipt-${process.pid}`,
    pineconeAllowedIndexes: [] as string[],
    voiceReply: 'never' as const,
    elevenlabs: { defaultVoiceId: 'v', defaultModel: 'm', stability: 0.5, similarityBoost: 0.75 },
    memory: { adminJid: 'admin@s.whatsapp.net' },
    ingest: { maxConcurrent: 1, maxQueueDepth: 10 },
  },
}));

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

vi.mock('../../../src/core/messages.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRecentMessages: vi.fn(() => []),
  getMessagesSince: vi.fn(() => []),
  updateMediaPath: vi.fn(),
  updateTranscription: vi.fn(),
}));

vi.mock('../../../src/core/command-router.ts', () => ({
  isAdminMessage: vi.fn(() => false), parseAdminCommand: vi.fn(() => null),
}));
vi.mock('../../../src/core/access-policy.ts', () => ({
  shouldRespond: vi.fn(() => ({ respond: true, reason: 'allowed' })),
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
  OutboundQueue: vi.fn().mockImplementation(function (_messenger: unknown, chatJid: string) {
    const double = makeQueueDouble(chatJid);
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
  WhatSoupSocketServer: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    updateDeliveryJid: vi.fn(),
    updateActorJid: vi.fn(),
    updateConversationKey: vi.fn(),
  })),
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

import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import { AgentRuntime, type AgentRuntimeOptions } from '../../../src/runtimes/agent/runtime.ts';
import { QUEUED_TURN_RECEIPT_TEXT } from '../../../src/runtimes/agent/runtime-queued-receipt.ts';
import { installFakePerChatMcpSocketManager } from './helpers/fake-per-chat-mcp-socket-manager.ts';

const chatJid = 'queued-receipt-chat@s.whatsapp.net';
const conversationKey = toConversationKey(chatJid);
const senderJid = '15550001@s.whatsapp.net';

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg-1',
    chatJid,
    senderJid,
    senderName: 'Test User',
    content: 'first question',
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

describe('#2949 queued receipt through the real per_chat admission path', () => {
  let db: Database;
  let engine: DurabilityEngine;
  let runtime: AgentRuntime;
  let messenger: Messenger;

  function makeRuntime(options: AgentRuntimeOptions): void {
    messenger = {
      sendMessage: vi.fn(async () => ({ waMessageId: null })),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
    } as unknown as Messenger;
    runtime = new AgentRuntime(db, messenger, 'test', options);
    installFakePerChatMcpSocketManager(runtime);
    runtime.setDurability(engine);
  }

  function receiptSends(): unknown[][] {
    return vi.mocked(messenger.sendMessage).mock.calls
      .filter((call) => call[1] === QUEUED_TURN_RECEIPT_TEXT);
  }

  async function arrive(messageId: string, content: string): Promise<number> {
    const seq = engine.journalInbound(messageId, conversationKey, chatJid, 'agent');
    await runtime.handleMessage(makeMsg({ messageId, content, inboundSeq: seq }));
    await (runtime as unknown as { turnChain: Promise<void> }).turnChain;
    return seq;
  }

  function liveQueue(): TurnQueue | undefined {
    return [...(runtime as unknown as { perChatTurnQueues: Map<string, TurnQueue> })
      .perChatTurnQueues.values()][0];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetDoubles();
    mockConfig.queuedTurnReceipt = true;
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
    vi.restoreAllMocks();
  });

  it('an idle message starts its turn and gets no receipt', async () => {
    makeRuntime({ sessionScope: 'per_chat' });

    const seq = await arrive('wamid-idle', 'first question');

    await vi.waitFor(() => expect(liveQueue()?.activeTurn?.inboundSeq).toBe(seq));
    expect(receiptSends()).toEqual([]);
  });

  it('a message queued behind the running task gets exactly one receipt, out of band and content-free', async () => {
    makeRuntime({ sessionScope: 'per_chat' });
    const first = await arrive('wamid-first', 'first question');
    await vi.waitFor(() => expect(sessionDoubles.some((s) => s.turnInFlight)).toBe(true));

    await arrive('wamid-second', 'please also send the Q3 invoice to finance');

    expect(liveQueue()?.activeTurn?.inboundSeq).toBe(first);
    expect(liveQueue()?.pending).toBe(1);
    await vi.waitFor(() => expect(receiptSends()).toHaveLength(1));
    expect(receiptSends()[0]).toEqual([chatJid, QUEUED_TURN_RECEIPT_TEXT]);
    expect(String(receiptSends()[0]?.[1])).not.toContain('invoice');
    // Out of band: the receipt never entered any per-turn outbound queue.
    for (const queue of queueDoubles) {
      expect(queue.enqueueText).not.toHaveBeenCalledWith(QUEUED_TURN_RECEIPT_TEXT);
      expect(queue.enqueueText).not.toHaveBeenCalledWith(QUEUED_TURN_RECEIPT_TEXT, expect.anything());
    }
  });

  it('the per-chat cooldown suppresses a second receipt behind the same task', async () => {
    makeRuntime({ sessionScope: 'per_chat' });
    await arrive('wamid-first', 'first question');
    await vi.waitFor(() => expect(sessionDoubles.some((s) => s.turnInFlight)).toBe(true));

    await arrive('wamid-second', 'second question');
    await arrive('wamid-third', 'third question');

    expect(liveQueue()?.pending).toBe(2);
    await vi.waitFor(() => expect(receiptSends()).toHaveLength(1));
  });

  it('the flag off sends no receipt for a queued message', async () => {
    mockConfig.queuedTurnReceipt = false;
    makeRuntime({ sessionScope: 'per_chat' });
    await arrive('wamid-first', 'first question');
    await vi.waitFor(() => expect(sessionDoubles.some((s) => s.turnInFlight)).toBe(true));

    await arrive('wamid-second', 'second question');

    expect(liveQueue()?.pending).toBe(1);
    expect(receiptSends()).toEqual([]);
  });

  it('single scope sends no receipt: a mid-task message waits in the turn chain, where /stop cannot reach the task', async () => {
    makeRuntime({ sessionScope: 'single' });
    const firstSeq = engine.journalInbound('wamid-single-first', conversationKey, chatJid, 'agent');
    const firstDone = runtime.handleMessage(makeMsg({ messageId: 'wamid-single-first', inboundSeq: firstSeq }));
    await vi.waitFor(() => expect(sessionDoubles.some((s) => s.turnInFlight)).toBe(true));

    const secondSeq = engine.journalInbound('wamid-single-second', conversationKey, chatJid, 'agent');
    const secondDone = runtime.handleMessage(
      makeMsg({ messageId: 'wamid-single-second', content: 'second question', inboundSeq: secondSeq }),
    );

    expect(receiptSends()).toEqual([]);
    const active = sessionDoubles.find((s) => s.turnInFlight)!;
    active.emit({ type: 'result', text: 'first answer' });
    active.completeProviderTurn();
    await firstDone;
    await vi.waitFor(() => expect(sessionDoubles.some((s) => s.turnInFlight)).toBe(true));
    const second = sessionDoubles.find((s) => s.turnInFlight)!;
    second.emit({ type: 'result', text: 'second answer' });
    second.completeProviderTurn();
    await secondDone;
    await (runtime as unknown as { turnChain: Promise<void> }).turnChain;

    expect(receiptSends()).toEqual([]);
  });
});
