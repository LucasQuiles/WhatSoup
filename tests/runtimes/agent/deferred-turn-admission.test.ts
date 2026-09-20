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
import { systemClock } from '../../../src/lib/clock.ts';
import type { TurnQueue } from '../../../src/runtimes/agent/turn-queue.ts';
import type { RuntimeTurnCoordinator } from '../../../src/runtimes/agent/runtime-turn-coordinator.ts';

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
    ingest: { maxConcurrent: 1, maxQueueDepth: 10 },
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
import { createIngestHandler, getIngestStats } from '../../../src/core/ingest.ts';
import { prepareContentForAgent } from '../../../src/runtimes/agent/media-prep.ts';
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

/**
 * Structured timing exemption (test-integrity `js-sleep-in-test`): the held
 * documents test is an ABSENCE proof — while the scope awaits the previous
 * answer's delivery echo, the queued head must neither dispatch nor be
 * rejected. The coordinator re-polls every 25 ms and a correct wait changes no
 * durable or session state, so the only observable to poll is the very
 * dispatch whose absence is asserted. Real time must cover several polls.
 */
function TIMING(waitMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, waitMs));
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

  function liveState() {
    return runtime as unknown as {
      perChatTurnQueues: Map<string, TurnQueue>;
      perChatInboundSeqQueue: Map<string, number[]>;
      runtimeTurnCoordinator: RuntimeTurnCoordinator;
    };
  }

  function terminalRows(seq: number) {
    return db.raw.prepare('SELECT attempt_kind, attempt_failure_class FROM turn_terminal_records WHERE inbound_seq = ?').all(seq);
  }

  async function waitForLiveQueue(seq: number) {
    await vi.waitFor(() => expect([...liveState().perChatTurnQueues.values()]
      .some((queue) => queue.activeTurn?.inboundSeq === seq)).toBe(true));
    const [mapKey, queue] = [...liveState().perChatTurnQueues.entries()]
      .find(([, candidate]) => candidate.activeTurn?.inboundSeq === seq)!;
    return { mapKey, queue };
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
  function seedOutstandingRecoveryJob(awaitingEcho = false, suffix = ''): number {
    const inboundSeq = engine.journalInbound('wamid-crashed-source' + suffix, conversationKey, chatJid, 'agent');
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
        logicalTurnId: 'turn-crashed-source' + suffix,
        managerId: 'manager-crashed-source',
        generation: 1,
      },
      attemptOutcome: awaitingEcho ? { kind: 'completed' } : { kind: 'failed', class: 'crash' },
      inboundDisposition: 'transferred_to_recovery_owner',
      deliveryEvidence: { kind: awaitingEcho ? 'flushed' : 'enqueued', opId: deliveryOpId },
    };
    const owner = {
      logicalTurnId: 'turn-crashed-source-recovery' + suffix,
      managerId: 'manager-recovery-owner',
      generation: 1,
    };
    const envelope = {
      sourceMessageId: 'wamid-crashed-source' + suffix,
      receivedAtUnixSeconds: 1_780_000_000,
      replaySafe: true,
      senderJid,
      senderName: 'Test User',
      text: 'original crashed question',
      isGroup: true,
      groupName: 'Deferral Lab',
    };
    if (awaitingEcho) {
      engine.markSending(deliveryOpId);
      engine.markSubmitted(deliveryOpId, 'wamid-original-answer' + suffix);
    }
    const receipt = engine.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(result, owner),
      recoveryJob: toTurnRecoveryJobPersistence(result, owner, envelope),
    });
    if (!awaitingEcho) {
      engine.markSending(deliveryOpId);
      db.raw.prepare(`UPDATE outbound_ops SET status = 'maybe_sent' WHERE id = ?`).run(deliveryOpId);
    }
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
    vi.restoreAllMocks();
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

  it('holds document followers until the original echo, then dispatches every document once in FIFO order', async () => {
    makeRuntime({ sessionScope: 'per_chat' });
    const jobId = seedOutstandingRecoveryJob(true);
    const contents = Array.from({ length: 6 }, (_, i) => `[Document: /tmp/month-${i}.pdf]\nStatement ${i}`);
    const seqs: number[] = [];
    for (const [i, content] of contents.entries()) {
      seqs.push(await arriveFollower(`wamid-document-${i}`, { contentType: 'document', content }));
    }
    await TIMING(100);
    expect(seqs.map(status)).toEqual(contents.map(() => 'processing'));
    expect(sessionDoubles.flatMap((session) => session.turnsSent)).toEqual([]);
    expect(admissionRejectedAlerts()).toBe(0);

    engine.matchEcho('wamid-original-answer');
    engine.matchEcho('wamid-original-answer');
    expect(engine.getTurnRecoveryJob(jobId)?.state).toBe('completed');
    for (let i = 0; i < contents.length; i++) {
      await vi.waitFor(() => expect(sessionDoubles.flatMap((session) => session.turnsSent)).toHaveLength(i + 1));
      const active = sessionDoubles.find((session) => session.turnInFlight)!;
      expect(active.turnsSent[i]).toBe(contents[i]);
      active.emit({ type: 'result', text: `Handled statement ${i}` });
    }
    await vi.waitFor(() => expect(sessionDoubles.every((session) => !session.turnInFlight)).toBe(true));
    expect(sessionDoubles.flatMap((session) => session.turnsSent)).toHaveLength(contents.length);
    expect(admissionRejectedAlerts()).toBe(0);
  });

  it('classifies only completed submitted delivery as a wait and preserves scope/job exclusion', () => {
    const jobId = seedOutstandingRecoveryJob(true);
    expect(engine.getTurnRecoveryAdmissionStateForScope('per_chat', conversationKey)).toBe('awaiting_delivery_echo');
    expect(engine.hasOutstandingTurnRecoveryForScope('per_chat', conversationKey)).toBe(true);
    expect(engine.getTurnRecoveryAdmissionStateForScope('per_chat', 'other-chat')).toBe('clear');
    expect(engine.getTurnRecoveryAdmissionStateForScope('per_chat', conversationKey, { excludeJobId: jobId })).toBe('clear');
    engine.claimTurnRecoveryJob(jobId, {
      logicalTurnId: 'turn-crashed-source-recovery', managerId: 'manager-recovery-owner', generation: 1,
    }, { claimToken: 'claim-for-negative-test', leaseSeconds: 60 });
    expect(engine.getTurnRecoveryAdmissionStateForScope('per_chat', conversationKey)).toBe('blocked');
  });

  it.each(['pending', 'sending', 'maybe_sent', 'failed', 'quarantined', 'echoed'])('does not wait on outbound status %s', (outboundStatus) => {
    seedOutstandingRecoveryJob(true);
    db.raw.prepare('UPDATE outbound_ops SET status = ?').run(outboundStatus);
    expect(engine.getTurnRecoveryAdmissionStateForScope('per_chat', conversationKey)).toBe('blocked');
    expect(engine.hasOutstandingTurnRecoveryForScope('per_chat', conversationKey)).toBe(true);
  });

  it('does not treat a broken source-message link as an echo wait', () => {
    seedOutstandingRecoveryJob(true);
    // Simulate corrupt persisted data beyond the normal write guard.
    db.raw.exec('DROP TRIGGER turn_recovery_source_inbound_identity_immutable');
    db.raw.prepare("UPDATE inbound_events SET message_id = 'corrupted-source-link'").run();
    expect(engine.getTurnRecoveryAdmissionStateForScope('per_chat', conversationKey)).toBe('blocked');
  });

  it('keeps an orphan transfer blocked even when a caller excludes its former job', () => {
    const jobId = seedOutstandingRecoveryJob(true);
    db.raw.prepare('DELETE FROM turn_recovery_jobs WHERE id = ?').run(jobId);
    expect(engine.getTurnRecoveryAdmissionStateForScope('per_chat', conversationKey, { excludeJobId: jobId })).toBe('blocked');
  });

  it('does not wait when the scope mixes a submitted answer and real crash recovery', () => {
    seedOutstandingRecoveryJob(true);
    const crashJob = seedOutstandingRecoveryJob(false, '-second');
    expect(engine.getTurnRecoveryAdmissionStateForScope('per_chat', conversationKey)).toBe('blocked');
    expect(engine.getTurnRecoveryAdmissionStateForScope('per_chat', conversationKey, { excludeJobId: crashJob })).toBe('awaiting_delivery_echo');
  });

  it('rejects through the final guard when a waiting job becomes claimed', async () => {
    makeRuntime({ sessionScope: 'per_chat' });
    const jobId = seedOutstandingRecoveryJob(true);
    const seq = await arriveFollower('waiting-then-claimed', { contentType: 'document' });
    // The live queue calls the echo wait synchronously, so an active head has already polled once.
    await waitForLiveQueue(seq);
    expect(status(seq)).toBe('processing');
    engine.claimTurnRecoveryJob(jobId, {
      logicalTurnId: 'turn-crashed-source-recovery', managerId: 'manager-recovery-owner', generation: 1,
    }, { claimToken: 'claimed-during-wait', leaseSeconds: 60 });
    await vi.waitFor(() => expect(status(seq)).toBe('failed'));
    expect(sessionDoubles.flatMap((session) => session.turnsSent)).toEqual([]);
    expect(terminalRows(seq)).toHaveLength(1);
  });

  it('durably rejects at the absolute echo deadline without replay or deferred obligation', async () => {
    makeRuntime({ sessionScope: 'per_chat' });
    seedOutstandingRecoveryJob(true);
    const clock = vi.spyOn(performance, 'now');
    clock.mockReturnValue(1_780_000_000_000);
    const seq = await arriveFollower('waiting-timeout', { contentType: 'document' });
    const { queue } = await waitForLiveQueue(seq);
    expect(status(seq)).toBe('processing');
    clock.mockReturnValue(1_780_000_010_000);
    await vi.waitFor(() => expect(status(seq)).toBe('failed'));
    expect(terminalRows(seq)).toEqual([{ attempt_kind: 'admission_rejected', attempt_failure_class: 'scope_blocked_recovery' }]);
    engine.matchEcho('wamid-original-answer');
    await queue.idle();
    expect(sessionDoubles.flatMap((session) => session.turnsSent)).toEqual([]);
    expect(obligationRows()).toEqual([]);
    clock.mockRestore();
  });

  it('cancels a waiting unpublished turn without dispatch when its crash finalizer owns it', async () => {
    makeRuntime({ sessionScope: 'per_chat' });
    seedOutstandingRecoveryJob(true);
    const seq = await arriveFollower('waiting-cancel', { contentType: 'document' });
    const { queue, mapKey } = await waitForLiveQueue(seq);
    const context = queue.activeTurn!.runtimeContext!;
    await liveState().runtimeTurnCoordinator.terminalizeUndispatchedRuntimeCrash(context, { value: mapKey });
    engine.matchEcho('wamid-original-answer');
    await queue.idle();
    expect(status(seq)).toBe('failed');
    expect(terminalRows(seq)).toHaveLength(1);
    expect(sessionDoubles.flatMap((session) => session.turnsSent)).toEqual([]);
    expect(liveState().perChatInboundSeqQueue.get(conversationKey) ?? []).toEqual([]);
  });

  it('shutdown terminalizes a waiting head and queued followers before a late echo', async () => {
    makeRuntime({ sessionScope: 'per_chat' });
    seedOutstandingRecoveryJob(true);
    const first = await arriveFollower('waiting-shutdown-a', { contentType: 'document' });
    const second = await arriveFollower('waiting-shutdown-b', { contentType: 'document' });
    const { queue } = await waitForLiveQueue(first);
    await runtime.shutdown();
    engine.matchEcho('wamid-original-answer');
    await queue.idle();
    expect([status(first), status(second)]).toEqual(['failed', 'failed']);
    expect(terminalRows(first)).toHaveLength(1);
    expect(terminalRows(second)).toHaveLength(1);
    expect(sessionDoubles.flatMap((session) => session.turnsSent)).toEqual([]);
  });

  it('ingests the releasing echo while ordinary ingest capacity is saturated', async () => {
    makeRuntime({ sessionScope: 'per_chat' });
    const jobId = seedOutstandingRecoveryJob(true);
    const seq = await arriveFollower('waiting-real-ingest-echo', { contentType: 'document' });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(runtime, 'handleMessage').mockImplementationOnce(() => held);
    const ingest = createIngestHandler(db, makeMessenger(), runtime, () => '15550000@s.whatsapp.net', () => null, engine);
    ingest(makeMsg({ messageId: 'ordinary-capacity-holder' }));
    try {
      await vi.waitFor(() => expect(getIngestStats().active).toBe(1));
      ingest(makeMsg({ messageId: 'wamid-original-answer', isFromMe: true, content: 'original answer' }));
      expect(engine.getTurnRecoveryJob(jobId)?.state).toBe('completed');
      await vi.waitFor(() => expect(sessionDoubles.flatMap((session) => session.turnsSent)).toHaveLength(1));
      expect(status(seq)).toBe('processing');
      expect(getIngestStats().active).toBe(1);
      sessionDoubles.find((session) => session.turnInFlight)!.emit({ type: 'result', text: 'handled' });
    } finally {
      release();
      await vi.waitFor(() => expect(getIngestStats().active).toBe(0));
    }
  });

  it('preserves a caption and both documents when media preparation completes out of receipt order', async () => {
    makeRuntime({ sessionScope: 'per_chat' });
    seedOutstandingRecoveryJob(true);
    let releaseSlow!: (text: string) => void;
    const slow = new Promise<string>((resolve) => { releaseSlow = resolve; });
    vi.mocked(prepareContentForAgent).mockImplementationOnce(() => slow);
    const caption = '[Document: /tmp/first.pdf]\nCompare both documents.\nFirst statement';
    const other = '[Document: /tmp/second.pdf]\nSecond statement';
    const firstSeq = engine.journalInbound('slow-captioned-document', conversationKey, chatJid, 'agent');
    const firstArrival = runtime.handleMessage(makeMsg({
      messageId: 'slow-captioned-document', inboundSeq: firstSeq, contentType: 'document', content: 'Compare both documents.',
    }));
    await vi.waitFor(() => expect(prepareContentForAgent).toHaveBeenCalled());
    const secondSeq = await arriveFollower('fast-document', { contentType: 'document', content: other });
    const { queue } = await waitForLiveQueue(secondSeq);
    releaseSlow(caption);
    await firstArrival;
    await vi.waitFor(() => expect(queue.pending).toBe(1));
    expect([status(firstSeq), status(secondSeq)]).toEqual(['processing', 'processing']);
    engine.matchEcho('wamid-original-answer');
    for (const [i, expected] of [other, caption].entries()) {
      await vi.waitFor(() => expect(sessionDoubles.flatMap((session) => session.turnsSent)).toHaveLength(i + 1));
      const active = sessionDoubles.find((session) => session.turnInFlight)!;
      expect(active.turnsSent[i]).toBe(expected);
      active.emit({ type: 'result', text: 'handled' });
    }
    await queue.idle();
    expect(sessionDoubles.flatMap((session) => session.turnsSent)).toEqual([other, caption]);
  });

  it('admits an unrelated chat while a document waits for an echo', async () => {
    makeRuntime({ sessionScope: 'per_chat' });
    seedOutstandingRecoveryJob(true);
    const seq = await arriveFollower('waiting-isolated-document', { contentType: 'document' });
    await waitForLiveQueue(seq);
    const otherJid = 'independent-chat@g.us';
    const otherSeq = engine.journalInbound('independent-question', toConversationKey(otherJid), otherJid, 'agent');
    await runtime.handleMessage(makeMsg({ messageId: 'independent-question', chatJid: otherJid, inboundSeq: otherSeq, content: 'Other chat question' }));
    await vi.waitFor(() => expect(sessionDoubles.flatMap((session) => session.turnsSent)).toEqual(['Other chat question']));
    expect(status(seq)).toBe('processing');
    const { queue: otherQueue } = await waitForLiveQueue(otherSeq);
    sessionDoubles.find((session) => session.turnInFlight)!.emit({ type: 'result', text: 'handled independently' });
    await otherQueue.idle();
  });

  it('rechecks shutdown after the ready promise handoff before publishing or consuming a poll', async () => {
    makeRuntime({ sessionScope: 'per_chat' });
    seedOutstandingRecoveryJob(true);
    const coordinator = liveState().runtimeTurnCoordinator as unknown as {
      waitForQueuedDeliveryEcho(...args: unknown[]): Promise<boolean>;
    };
    const original = coordinator.waitForQueuedDeliveryEcho.bind(coordinator);
    let reached!: () => void;
    const ready = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void;
    const handoff = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(coordinator, 'waitForQueuedDeliveryEcho').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (result) { reached(); await handoff; }
      return result;
    });
    const seq = await arriveFollower('shutdown-at-ready-handoff', { contentType: 'document' });
    const { queue } = await waitForLiveQueue(seq);
    engine.matchEcho('wamid-original-answer');
    await ready;
    try {
      await runtime.shutdown();
    } finally {
      release();
    }
    await queue.idle();
    expect(status(seq)).toBe('failed');
    expect(terminalRows(seq)).toHaveLength(1);
    expect(liveState().perChatInboundSeqQueue.size).toBe(0);
    expect(queueDoubles.flatMap((outbound) => outbound.hasPendingPoll.mock.calls)).toEqual([]);
    expect(sessionDoubles.flatMap((session) => session.turnsSent)).toEqual([]);
  });

  it('rejects a lost live queue receipt before initial publication', async () => {
    makeRuntime({ sessionScope: 'per_chat' });
    const coordinator = liveState().runtimeTurnCoordinator;
    const original = coordinator.processPerChatTurn.bind(coordinator);
    vi.spyOn(coordinator, 'processPerChatTurn').mockImplementationOnce(async (...args) => {
      liveState().perChatTurnQueues.delete(args[0].value);
      await original(...args);
    });
    const seq = await arriveFollower('lost-live-queue', { contentType: 'document' });
    await vi.waitFor(() => expect(status(seq)).toBe('failed'));
    expect(terminalRows(seq)).toHaveLength(1);
    expect(liveState().perChatInboundSeqQueue.size).toBe(0);
    expect(sessionDoubles.flatMap((session) => session.turnsSent)).toEqual([]);
  });

  it('retains the FIFO when timeout finalization cannot establish durable ownership', async () => {
    makeRuntime({ sessionScope: 'per_chat' });
    seedOutstandingRecoveryJob(true);
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1_780_000_000_000);
    const seq = await arriveFollower('timeout-persistence-failure', { contentType: 'document' });
    const { queue } = await waitForLiveQueue(seq);
    const second = await arriveFollower('behind-persistence-failure', { contentType: 'document' });
    await vi.waitFor(() => expect(queue.pending).toBe(1));
    const finalize = vi.spyOn(engine, 'finalizeTurnTerminal').mockImplementation(() => {
      throw new Error('injected terminal persistence failure');
    });
    try {
      clock.mockReturnValue(1_780_000_010_000);
      await vi.waitFor(() => expect(finalize).toHaveBeenCalled());
      expect(queue.activeTurn?.inboundSeq).toBe(seq);
      expect(queue.pending).toBe(1);
      expect([status(seq), status(second)]).toEqual(['processing', 'processing']);
      expect(sessionDoubles.flatMap((session) => session.turnsSent)).toEqual([]);
    } finally {
      finalize.mockRestore();
      clock.mockRestore();
      await liveState().runtimeTurnCoordinator.retryRuntimeTurnFinalizations();
    }
  });

  it('shutdown joins timeout terminal ownership while the finalization promise is still settling', async () => {
    makeRuntime({ sessionScope: 'per_chat' });
    seedOutstandingRecoveryJob(true);
    const coordinator = liveState().runtimeTurnCoordinator;
    const original = coordinator.finalizeUndispatchedRuntimeTurnAndWait.bind(coordinator);
    let reached!: () => void;
    const persisted = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void;
    const settling = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(coordinator, 'finalizeUndispatchedRuntimeTurnAndWait').mockImplementationOnce(async (...args) => {
      await original(...args);
      reached();
      await settling;
    });
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1_780_000_000_000);
    const seq = await arriveFollower('shutdown-during-timeout-finalization', { contentType: 'document' });
    const { queue } = await waitForLiveQueue(seq);
    clock.mockReturnValue(1_780_000_010_000);
    await persisted;
    clock.mockRestore();
    try {
      await runtime.shutdown();
    } finally {
      release();
    }
    await queue.idle();
    expect(terminalRows(seq)).toEqual([{ attempt_kind: 'admission_rejected', attempt_failure_class: 'scope_blocked_recovery' }]);
    expect(sessionDoubles.flatMap((session) => session.turnsSent)).toEqual([]);
  });

  it('bounds the echo wait when the wall clock moves backwards and then freezes', async () => {
    makeRuntime({ sessionScope: 'per_chat' });
    seedOutstandingRecoveryJob(true);
    const wall = vi.spyOn(systemClock, 'now').mockReturnValue(1_780_000_000_000);
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(100);
    const seq = await arriveFollower('wall-clock-rollback', { contentType: 'document' });
    await waitForLiveQueue(seq);
    wall.mockReturnValue(1_779_999_900_000);
    monotonic.mockReturnValue(10_100);
    try {
      await vi.waitFor(() => expect(status(seq)).toBe('failed'));
      expect(terminalRows(seq)).toEqual([{ attempt_kind: 'admission_rejected', attempt_failure_class: 'scope_blocked_recovery' }]);
      expect(sessionDoubles.flatMap((session) => session.turnsSent)).toEqual([]);
    } finally {
      wall.mockRestore();
      monotonic.mockRestore();
    }
  });

  it('preserves a retained timeout outcome when persistence recovers before shutdown retries it', async () => {
    makeRuntime({ sessionScope: 'per_chat' });
    seedOutstandingRecoveryJob(true);
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1_780_000_000_000);
    const seq = await arriveFollower('retained-timeout-shutdown', { contentType: 'document' });
    const { queue } = await waitForLiveQueue(seq);
    const finalize = vi.spyOn(engine, 'finalizeTurnTerminal').mockImplementation(() => { throw new Error('injected persistence failure'); });
    clock.mockReturnValue(1_780_000_010_000);
    await vi.waitFor(() => expect(finalize).toHaveBeenCalled());
    finalize.mockRestore();
    clock.mockRestore();
    await runtime.shutdown();
    await queue.idle();
    expect(terminalRows(seq)).toEqual([{ attempt_kind: 'admission_rejected', attempt_failure_class: 'scope_blocked_recovery' }]);
    expect(sessionDoubles.flatMap((session) => session.turnsSent)).toEqual([]);
  });
});
