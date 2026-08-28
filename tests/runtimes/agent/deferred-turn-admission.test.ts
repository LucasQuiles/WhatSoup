// #3295 S2 — flagged admission defer (recovery-blocked followers).
//
// Contract (ratified slice plan, S2): behind a default-OFF flag, a follower
// blocked SOLELY by `hasOutstandingTurnRecoveryForScope` — and classified
// replay-safe (text turn, replaySafe envelope, no dispatch started) — becomes
// a durable `deferred_turn_obligations` row (status pending) instead of a
// terminal admission rejection. Every other rejection class keeps today's
// terminal path bit-for-bit. The flag is evaluated PER ADMISSION (kill-switch
// semantics), never cached at construction. Drain is S3; in S2 an obligation
// only accumulates — dark until the supervisor lands.
//
// Harness: REAL AgentRuntime + REAL RuntimeTurnCoordinator + REAL SQLite
// DurabilityEngine (migration 62 applied by Database.open). Only the provider
// boundary is faked (module-mock pattern of scheduled-turn-lifecycle.test.ts).
// The outstanding recovery job is created through the REAL
// `finalizeTurnTerminal` transfer path — not a hand-inserted row.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Messenger, IncomingMessage } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import { toConversationKey } from '../../../src/core/conversation-key.ts';

// ─── Hoisted provider-boundary doubles (scheduled-turn-lifecycle pattern) ───

const { sessionDoubles, queueDoubles, resetDoubles, makeSessionDouble, makeQueueDouble } = vi.hoisted(() => {
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

  function resetDoubles(): void {
    sessionDoubles.length = 0;
    queueDoubles.length = 0;
  }

  return { sessionDoubles, queueDoubles, resetDoubles, makeSessionDouble, makeQueueDouble };
});

const { mockConfig, mockEmitAlertChecked } = vi.hoisted(() => ({
  mockEmitAlertChecked: vi.fn(),
  mockConfig: {
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set<string>(['15550001']),
    controlPeers: new Map<string, string>(),
    internalPeerJids: new Set<string>(),
    toolUpdateMode: 'full' as const,
    toolUpdateRedirectJid: null as string | null,
    textAggregateDelayMs: 2_000,
    stateRoot: `/tmp/whatsoup-test-state-deferred-admission-${process.pid}`,
    restartLoopGuard: { enabled: true, maxRestarts: 3, windowMs: 300_000 },
    startupNotifications: false,
    proactiveResumeOnStartup: false,
    mediaDir: `/tmp/whatsoup-test-media-deferred-admission-${process.pid}`,
    pineconeAllowedIndexes: [] as string[],
    voiceReply: 'never' as const,
    elevenlabs: { defaultVoiceId: 'v', defaultModel: 'm', stability: 0.5, similarityBoost: 0.75 },
    memory: { adminJid: 'admin@s.whatsapp.net' },
  },
}));

// ─── Module mocks (provider boundary + side-effect surfaces only) ───────────

vi.mock('../../../src/logger.ts', async () => {
  const { loggerMock } = await import('../../helpers/logger-mock.ts');
  return loggerMock();
});

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlert: vi.fn(),
  emitAlertChecked: mockEmitAlertChecked,
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

// ─── Imports under test (after mocks) ───────────────────────────────────────

import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import { AgentRuntime, type AgentRuntimeOptions } from '../../../src/runtimes/agent/runtime.ts';
import { toTurnFinalizationPersistence, toTurnRecoveryJobPersistence, type TurnTerminalResult } from '../../../src/runtimes/agent/turn-terminal.ts';
import { installFakePerChatMcpSocketManager } from './helpers/fake-per-chat-mcp-socket-manager.ts';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const chatJid = 'test-deferral-group@g.us';
const conversationKey = toConversationKey(chatJid);
const senderJid = '15550001@s.whatsapp.net';

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg-follower-1',
    chatJid,
    senderJid,
    senderName: 'Test User',
    content: 'follower question',
    contentText: null,
    contentType: 'text',
    isFromMe: false,
    isGroup: true,
    mentionedJids: [],
    timestamp: Date.now(),
    quotedMessageId: null,
    isResponseWorthy: true,
    ...overrides,
  };
}

describe('deferred-turn admission (#3295 S2)', () => {
  let db: Database;
  let engine: DurabilityEngine;
  let runtime: AgentRuntime;

  function status(seq: number): string {
    return (db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(seq) as {
      processing_status: string;
    }).processing_status;
  }

  function obligationRows(): Array<{ inbound_seq: number; status: string; scope: string }> {
    return db.raw
      .prepare('SELECT inbound_seq, status, scope FROM deferred_turn_obligations ORDER BY inbound_seq')
      .all() as Array<{ inbound_seq: number; status: string; scope: string }>;
  }

  function admissionRejectedAlerts(): number {
    return mockEmitAlertChecked.mock.calls.filter(
      (call) => call[1] === 'agent_turn_admission_rejected',
    ).length;
  }

  function makeRuntime(options: AgentRuntimeOptions): void {
    runtime = new AgentRuntime(db, makeMessenger(), 'test', options);
    installFakePerChatMcpSocketManager(runtime);
    runtime.setDurability(engine);
  }

  /**
   * Creates one OUTSTANDING turn-recovery job for this chat's scope through
   * the REAL finalizeTurnTerminal transfer path (a crashed source turn whose
   * delivery is ambiguous), so `hasOutstandingTurnRecoveryForScope` is the
   * real predicate over real rows — never a stub.
   */
  function seedOutstandingRecoveryJob(): number {
    const inboundSeq = engine.journalInbound('wamid-crashed-source', conversationKey, chatJid, 'agent');
    const deliveryOpId = engine.createOutboundOp({
      conversationKey,
      chatJid,
      opType: 'text',
      payload: JSON.stringify({ text: 'partial reply' }),
      sourceInboundSeq: inboundSeq,
      replayPolicy: 'unsafe',
    });
    const result: TurnTerminalResult = {
      identity: {
        scope: 'per_chat',
        conversationKey,
        deliveryJid: chatJid,
        inboundSeq,
        logicalTurnId: 'turn-crashed-source',
        managerId: 'manager-crashed-source',
        generation: 1,
      },
      attemptOutcome: { kind: 'failed', class: 'crash' },
      inboundDisposition: 'transferred_to_recovery_owner',
      deliveryEvidence: { kind: 'enqueued', opId: deliveryOpId },
    };
    const owner = {
      logicalTurnId: 'turn-crashed-source-recovery',
      managerId: 'manager-recovery-owner',
      generation: 1,
    };
    const envelope = {
      sourceMessageId: 'wamid-crashed-source',
      receivedAtUnixSeconds: 1_780_000_000,
      replaySafe: true,
      senderJid,
      senderName: 'Test User',
      text: 'original crashed question',
      isGroup: true,
      groupName: 'Deferral Lab',
    };
    const receipt = engine.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(result, owner),
      recoveryJob: toTurnRecoveryJobPersistence(result, owner, envelope),
    });
    engine.markSending(deliveryOpId);
    db.raw.prepare(`UPDATE outbound_ops SET status = 'maybe_sent' WHERE id = ?`).run(deliveryOpId);
    expect(receipt.recoveryJob).toBeDefined();
    expect(
      engine.hasOutstandingTurnRecoveryForScope('per_chat', conversationKey),
    ).toBe(true);
    return receipt.recoveryJob!.jobId;
  }

  /** Journal + deliver one follower inbound through the real handleMessage path. */
  async function arriveFollower(messageId: string, overrides: Partial<IncomingMessage> = {}): Promise<number> {
    const seq = engine.journalInbound(messageId, conversationKey, chatJid, 'agent');
    await runtime.handleMessage(makeMsg({ ...overrides, messageId, inboundSeq: seq }));
    // The processor chain settles asynchronously behind the turn chain.
    await (runtime as unknown as { turnChain: Promise<void> }).turnChain;
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

  it('flag ON: a replay-safe follower blocked solely by outstanding recovery becomes a pending obligation — inbound stays processing, no terminal rejection', async () => {
    makeRuntime({ sessionScope: 'per_chat', deferredTurnAdmission: { enabled: true } });
    seedOutstandingRecoveryJob();

    const seq = await arriveFollower('wamid-follower-deferred');

    await vi.waitFor(() => {
      expect(obligationRows()).toEqual([
        { inbound_seq: seq, status: 'pending', scope: 'per_chat' },
      ]);
    }, { timeout: 4_000 });
    // The durable owner is now the obligation: the journal row must NOT be
    // terminally failed (that is exactly the loss class #3295 removes).
    expect(status(seq)).toBe('processing');
    expect(admissionRejectedAlerts()).toBe(0);
    // The runtime lane is retired cleanly: no leaked per-chat FIFO context.
    const contexts = (runtime as unknown as { perChatRuntimeTurnContexts: Map<string, unknown[]> })
      .perChatRuntimeTurnContexts;
    for (const [, list] of contexts) expect(list).toHaveLength(0);
  });

  it('flag OFF (default): the same follower keeps today\'s terminal admission rejection bit-for-bit', async () => {
    makeRuntime({ sessionScope: 'per_chat' });
    seedOutstandingRecoveryJob();

    const seq = await arriveFollower('wamid-follower-terminal');

    await vi.waitFor(() => {
      expect(status(seq)).toBe('failed');
    }, { timeout: 4_000 });
    expect(obligationRows()).toEqual([]);
    expect(admissionRejectedAlerts()).toBeGreaterThan(0);
  });

  it('flag ON but replay-unsafe content (media): keeps today\'s terminal path — no obligation', async () => {
    makeRuntime({ sessionScope: 'per_chat', deferredTurnAdmission: { enabled: true } });
    seedOutstandingRecoveryJob();

    const seq = await arriveFollower('wamid-follower-media', {
      contentType: 'image',
      content: '[media: photo.jpg]',
    });

    await vi.waitFor(() => {
      expect(status(seq)).toBe('failed');
    }, { timeout: 4_000 });
    expect(obligationRows()).toEqual([]);
  });

  it('kill switch: the flag is evaluated per admission — flipping it off after construction stops deferral', async () => {
    const options: AgentRuntimeOptions = {
      sessionScope: 'per_chat',
      deferredTurnAdmission: { enabled: true },
    };
    makeRuntime(options);
    seedOutstandingRecoveryJob();

    const deferredSeq = await arriveFollower('wamid-follower-before-kill');
    await vi.waitFor(() => {
      expect(obligationRows().map((row) => row.inbound_seq)).toEqual([deferredSeq]);
    }, { timeout: 4_000 });

    options.deferredTurnAdmission!.enabled = false;

    const terminalSeq = await arriveFollower('wamid-follower-after-kill');
    await vi.waitFor(() => {
      expect(status(terminalSeq)).toBe('failed');
    }, { timeout: 4_000 });
    // No second obligation was created after the kill switch flipped.
    expect(obligationRows().map((row) => row.inbound_seq)).toEqual([deferredSeq]);
  });

  it('accumulates multiple deferred followers in inbound order while the scope stays blocked', async () => {
    makeRuntime({ sessionScope: 'per_chat', deferredTurnAdmission: { enabled: true } });
    seedOutstandingRecoveryJob();

    const first = await arriveFollower('wamid-follower-a');
    const second = await arriveFollower('wamid-follower-b');

    await vi.waitFor(() => {
      expect(obligationRows().map((row) => row.inbound_seq)).toEqual([first, second]);
    }, { timeout: 4_000 });
    expect(status(first)).toBe('processing');
    expect(status(second)).toBe('processing');
    expect(admissionRejectedAlerts()).toBe(0);
  });
});
