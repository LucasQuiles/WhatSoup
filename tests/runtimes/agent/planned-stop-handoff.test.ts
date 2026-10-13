// #3703 — planned stop (SIGTERM during a release activation) must not lose an
// admitted turn, and must not report a clean stop when it did.
//
// Incident shape (mini2 ar-bot, 2026-10-13): a DM was dispatched to the
// provider, SIGTERM arrived 14 s later, AgentRuntime.shutdown() finalized the
// turn `failed / session_crash` (continuity candidate
// runtime_fault_no_terminal_outbound), and main.ts still logged
// `shutdown complete` and exited 0. No reply, no recovery.
//
// Contract these cases pin (design:
// docs/superpowers/specs/2026-10-13-3703-planned-stop-handoff-design.md):
//   T1  a NEVER-DISPATCHED replay-safe text turn present at shutdown is not
//       finalized failed; it is handed to the #3295 durable deferred-turn
//       owner, and the next start dispatches it exactly once.
//   T2  a DISPATCHED turn is drained (bounded): if the provider answers inside
//       the bound the reply is delivered and the stop is clean.
//   T3  bound exceeded (or the handoff write fails): the turn stays
//       failed_terminal — never silently transferred — and shutdown REJECTS.
//   T4  composed with main's shutdown sequence, T3 is `shutdown incomplete`
//       (no `shutdown complete`, exit 1).
//   T5  two starts after a handoff dispatch the inbound at most once; after
//       `dispatched_commit` there is no automatic replay.
//
// Scope: these cases exercise the NEW runtime's shutdown. They say nothing
// about the first old-to-new cutover, where the stop is executed by the OLD
// release's shutdown (the 3603 loss). That boundary stays separate and needs
// the admission/drain/ownership property shown through the actual supported
// route before rollout.
//
// Status: T2, T3a and T4 are plain assertions, fixed by the bounded
// planned-stop drain and the loss report (planned-stop-drain.ts). T1, T1b,
// T3b, T5a and T5b stay `it.fails`: they need a durable owner that dispatches a
// handed-off turn on the next start, and the #3295 deferred-obligation drain
// consumer that would do it does not exist yet.
//
// RED convention (scheduled-turn-lifecycle.test.ts): each probe asserts the
// DESIRED property and is committed as `it.fails` while main lacks it; landing
// the fix flips it red and forces promotion to a plain `it`. A passing
// `it.fails` is an expected failure, never evidence of a repaired release. Every probe was
// verified to fail at a668b5cff on an assertion (not a harness error) — the
// exact reasons are recorded in the design doc.
//
// Harness: REAL AgentRuntime + REAL RuntimeTurnCoordinator + REAL TurnQueues +
// REAL SQLite DurabilityEngine. Only the provider boundary (SessionManager),
// the outbound queue and side-effect surfaces are module-mocked, following
// deferred-turn-admission.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Messenger, IncomingMessage } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import { toConversationKey } from '../../../src/core/conversation-key.ts';
import { TurnQueue } from '../../../src/runtimes/agent/turn-queue.ts';

// ─── Hoisted provider-boundary doubles (scheduled-turn-lifecycle pattern) ───

const { sessionDoubles, queueDoubles, sessionConstructHooks, resetDoubles, makeSessionDouble, makeQueueDouble } = vi.hoisted(() => {
  type SessionCtorOpts = {
    chatJid: string;
    persistenceConversationKey?: string;
    provider?: string;
    onEvent: (event: AgentEvent) => void;
    onCrash?: (info: unknown) => void;
    notifyUser?: (msg: string) => void;
  };

  function makeSessionDouble(opts: SessionCtorOpts) {
    let active = false;
    let pendingResolve: (() => void) | null = null;
    let pendingReject: ((err: unknown) => void) | null = null;
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
      /** The provider child dies mid-turn: the in-flight send rejects. */
      failProviderTurn(err: unknown): void {
        const reject = pendingReject;
        pendingResolve = null;
        pendingReject = null;
        reject?.(err);
      },
      spawnSession: vi.fn(async () => {
        active = true;
      }),
      sendTurn: vi.fn((input: unknown) => {
        double.turnsSent.push(input);
        pendingPromise = new Promise<void>((resolve, reject) => {
          pendingResolve = resolve;
          pendingReject = reject;
        });
        return pendingPromise;
      }),
      completeProviderTurn: vi.fn(() => {
        const resolve = pendingResolve;
        pendingResolve = null;
        pendingReject = null;
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
      // The route the runtime spawned this session on, as a real manager reports.
      getProviderId: vi.fn(() => opts.provider ?? 'claude-cli'),
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
  /** One-shot setup applied to the next constructed session double, in order. */
  const sessionConstructHooks: Array<(double: ReturnType<typeof makeSessionDouble>) => void> = [];

  function resetDoubles(): void {
    sessionDoubles.length = 0;
    queueDoubles.length = 0;
    sessionConstructHooks.length = 0;
  }

  return { sessionDoubles, queueDoubles, sessionConstructHooks, resetDoubles, makeSessionDouble, makeQueueDouble };
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
    stateRoot: `/tmp/whatsoup-test-state-planned-stop-handoff-${process.pid}`,
    restartLoopGuard: { enabled: true, maxRestarts: 3, windowMs: 300_000 },
    startupNotifications: false,
    proactiveResumeOnStartup: false,
    mediaDir: `/tmp/whatsoup-test-media-planned-stop-handoff-${process.pid}`,
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
    sessionConstructHooks.shift()?.(double);
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
import { runShutdownSequence, shutdownExitCode } from '../../../src/main-shutdown-policy.ts';
import { installFakePerChatMcpSocketManager } from './helpers/fake-per-chat-mcp-socket-manager.ts';
import { PlannedStopQueueCloseError } from '../../../src/runtimes/agent/planned-stop-drain.ts';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const dmJid = '15550190931@s.whatsapp.net';
const conversationKey = toConversationKey(dmJid);
const senderJid = dmJid;

/**
 * The bounded in-flight drain a planned stop grants a dispatched turn. Not an
 * option on main (unknown keys are ignored there); the fix reads it. Kept
 * short so the bound-exceeded cases stay well inside the per-test budget.
 */
type PlannedStopOptions = AgentRuntimeOptions & { plannedStopDrainMs?: number };
const SHORT_DRAIN_MS = 150;
const LONG_DRAIN_MS = 3_000;

/**
 * Structured timing exemption (test-integrity `js-sleep-in-test`): T2 must
 * answer the provider turn AFTER shutdown has had the chance to finalize it.
 * On main the crash finalization lands within microtasks of shutdown();
 * 50 ms of real time is far past that and far inside LONG_DRAIN_MS.
 */
function TIMING(waitMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, waitMs));
}

type SessionDouble = (typeof sessionDoubles)[number];
type QueueDouble = (typeof queueDoubles)[number];

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'wamid-planned-stop',
    chatJid: dmJid,
    senderJid,
    senderName: 'Test User',
    content: 'planned stop question',
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

function providerText(input: unknown): string {
  if (typeof input === 'string') return input;
  const structured = input as { userText?: string; applicationContext?: readonly string[] };
  return [...(structured.applicationContext ?? []), structured.userText ?? ''].join('\n');
}

describe('planned stop handoff (#3703)', () => {
  let db: Database;
  let runtimes: AgentRuntime[];

  beforeEach(() => {
    vi.clearAllMocks();
    resetDoubles();
    db = new Database(':memory:');
    db.open();
    runtimes = [];
  });

  afterEach(async () => {
    for (const session of sessionDoubles) {
      if (session.turnInFlight) session.emit({ type: 'result', text: 'late' });
    }
    for (const runtime of runtimes) await runtime.shutdown().catch(() => {});
    db.close();
    vi.restoreAllMocks();
  });

  /** One process generation: a fresh engine (startup recovery first, as main.ts 2b) and runtime on the SAME db. */
  function startProcess(options: PlannedStopOptions = {}): { runtime: AgentRuntime; engine: DurabilityEngine } {
    const engine = new DurabilityEngine(db);
    engine.preConnectRecovery();
    const runtime = new AgentRuntime(db, makeMessenger(), 'test', { sessionScope: 'per_chat', ...options });
    installFakePerChatMcpSocketManager(runtime);
    runtime.setDurability(engine);
    runtimes.push(runtime);
    return { runtime, engine };
  }

  function status(seq: number): string {
    return (db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(seq) as {
      processing_status: string;
    }).processing_status;
  }

  function terminalRows(seq: number) {
    return db.raw.prepare(
      'SELECT attempt_kind, attempt_failure_class, inbound_disposition FROM turn_terminal_records WHERE inbound_seq = ?',
    ).all(seq) as Array<{ attempt_kind: string; attempt_failure_class: string | null; inbound_disposition: string }>;
  }

  function obligationStatuses(seq: number): string[] {
    return (db.raw.prepare('SELECT status FROM deferred_turn_obligations WHERE inbound_seq = ?').all(seq) as Array<{
      status: string;
    }>).map((row) => row.status);
  }

  function dispatchesOf(content: string, sessions: readonly SessionDouble[] = sessionDoubles): number {
    return sessions.flatMap((session) => session.turnsSent).filter((input) => providerText(input).includes(content)).length;
  }

  function queueFor(jid: string): QueueDouble {
    const queue = [...queueDoubles].reverse().find((candidate) => candidate.targetChatJid === jid);
    expect(queue).toBeDefined();
    return queue!;
  }

  /** The transport delivers and echoes the next answer for `seq` (as OutboundQueue would report it). */
  function echoNextAnswer(engine: DurabilityEngine, queue: QueueDouble, seq: number): void {
    const opId = engine.createOutboundOp({
      conversationKey,
      chatJid: dmJid,
      opType: 'text',
      payload: JSON.stringify({ text: 'drained answer' }),
      replayPolicy: 'safe',
      sourceInboundSeq: seq,
    });
    engine.markSending(opId);
    engine.markSubmitted(opId, `wamid-answer-${seq}`);
    engine.markEchoed(opId);
    (queue.flushTurnEvidence as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (turnId: string) => ({ turnId, answerOpIds: [opId], lifecycleOpIds: [], statusOpIds: [] }),
    );
  }

  /** Journal one inbound (ingest step 5) and hand it to the runtime (ingest step 6). */
  async function arrive(runtime: AgentRuntime, engine: DurabilityEngine, messageId: string, content: string): Promise<number> {
    const seq = engine.journalInbound(messageId, conversationKey, dmJid, 'agent');
    await runtime.handleMessage(makeMsg({ messageId, content, inboundSeq: seq }));
    return seq;
  }

  /** Arrive and wait until the provider holds the turn (dispatched, unanswered). */
  async function arriveInFlight(runtime: AgentRuntime, engine: DurabilityEngine, messageId: string, content: string) {
    const seq = await arrive(runtime, engine, messageId, content);
    let session: SessionDouble | undefined;
    await vi.waitFor(() => {
      session = sessionDoubles.find((candidate) => candidate.turnInFlight
        && candidate.turnsSent.some((input) => providerText(input).includes(content)));
      expect(session).toBeDefined();
    });
    return { seq, session: session! };
  }

  /** Arrive behind an in-flight turn of the same chat: admitted to the per-chat FIFO, NOT dispatched. */
  async function arriveQueuedBehind(runtime: AgentRuntime, engine: DurabilityEngine, messageId: string, content: string) {
    const seq = await arrive(runtime, engine, messageId, content);
    await vi.waitFor(() => {
      const queues = (runtime as unknown as { perChatTurnQueues: Map<string, TurnQueue> }).perChatTurnQueues;
      // TurnQueue's private FIFO (turn-queue.ts `queue`): admitted, not yet handed to the processor.
      const pending = [...queues.values()].some((queue) =>
        (queue as unknown as { queue: Array<{ inboundSeq?: number }> }).queue.some((turn) => turn.inboundSeq === seq));
      expect(pending).toBe(true);
    });
    expect(dispatchesOf(content)).toBe(0);
    return seq;
  }

  // ─── T1: never-dispatched turn → durable handoff → dispatched once on next start ───

  it.fails('T1: a turn admitted behind an in-flight turn (after a quiet stop-check) is handed off, not failed, and the next start dispatches it exactly once', async () => {
    const a = startProcess({ plannedStopDrainMs: SHORT_DRAIN_MS } as PlannedStopOptions);
    await arriveInFlight(a.runtime, a.engine, 'wamid-t1-head', 't1 head question');
    const follower = await arriveQueuedBehind(a.runtime, a.engine, 'wamid-t1-follower', 't1 follower question');

    // Planned stop. The head (dispatched, unanswered) exceeds the drain bound and
    // fails honestly (T3); that rejection is not this case's subject.
    await a.runtime.shutdown().catch(() => {});

    // The follower was never dispatched: it is durably owned, not terminal.
    expect(status(follower)).toBe('processing');
    expect(terminalRows(follower)).toEqual([]);
    expect(obligationStatuses(follower)).toEqual(['pending']);
    expect(dispatchesOf('t1 follower question')).toBe(0);

    // Next start: startup recovery must not fail-mark the owned inbound, and the
    // owner dispatches it exactly once.
    const before = sessionDoubles.length;
    const b = startProcess();
    expect(status(follower)).toBe('processing');
    await vi.waitFor(() => expect(dispatchesOf('t1 follower question', sessionDoubles.slice(before))).toBe(1), { timeout: 3_000 });
    const session = sessionDoubles.slice(before).find((candidate) => candidate.turnInFlight)!;
    echoNextAnswer(b.engine, queueFor(dmJid), follower);
    session.emit({ type: 'result', text: 't1 follower answer' });
    await vi.waitFor(() => expect(status(follower)).toBe('complete'), { timeout: 3_000 });
    expect(obligationStatuses(follower)).toEqual(['terminal_completed']);
    expect(dispatchesOf('t1 follower question')).toBe(1);
  });

  it.fails('T1b: a message handed to the runtime while shutdown is draining is handed off (not rejected / failed)', async () => {
    const a = startProcess({ plannedStopDrainMs: SHORT_DRAIN_MS } as PlannedStopOptions);
    await arriveInFlight(a.runtime, a.engine, 'wamid-t1b-head', 't1b head question');
    const stopping = a.runtime.shutdown().catch(() => {});
    // Arrives on the still-open socket during the runtime phase of shutdown
    // (main.ts tears the transport down only after runtime.shutdown()).
    const seq = a.engine.journalInbound('wamid-t1b-late', conversationKey, dmJid, 'agent');
    const admitted = await a.runtime.handleMessage(makeMsg({ messageId: 'wamid-t1b-late', content: 't1b late', inboundSeq: seq }))
      .then(() => 'accepted', () => 'rejected');
    await stopping;
    expect(admitted).toBe('accepted');
    expect(status(seq)).toBe('processing');
    expect(terminalRows(seq)).toEqual([]);
    expect(obligationStatuses(seq)).toEqual(['pending']);
  });

  // ─── T2: dispatched turn answered inside the drain bound ───

  it('T2: shutdown waits (bounded) for a dispatched turn; an answer inside the bound is delivered and the stop is clean', async () => {
    const a = startProcess({ plannedStopDrainMs: LONG_DRAIN_MS } as PlannedStopOptions);
    const { seq, session } = await arriveInFlight(a.runtime, a.engine, 'wamid-t2', 't2 question');

    const stopping = a.runtime.shutdown().then(() => null, (error: unknown) => error);
    await TIMING(50);
    // Still draining: shutdown has not finalized the dispatched turn as a crash.
    expect(status(seq)).toBe('processing');
    expect(terminalRows(seq)).toEqual([]);

    echoNextAnswer(a.engine, queueFor(dmJid), seq);
    session.emit({ type: 'result', text: 't2 answer' });

    expect(await stopping).toBeNull();
    expect(status(seq)).toBe('complete');
    expect(terminalRows(seq)).toEqual([
      { attempt_kind: 'completed', attempt_failure_class: null, inbound_disposition: 'finalized_replied' },
    ]);
    expect(queueFor(dmJid).enqueueResultText).toHaveBeenCalledWith(expect.stringContaining('t2 answer'), 'answer');
  });

  // ─── T3: bound exceeded / handoff write fails → honest failure + incomplete ───

  it('T3a: a dispatched turn that outlives the drain bound stays failed_terminal (never transferred) and shutdown rejects', async () => {
    const a = startProcess({ plannedStopDrainMs: SHORT_DRAIN_MS } as PlannedStopOptions);
    const { seq } = await arriveInFlight(a.runtime, a.engine, 'wamid-t3a', 't3a question');

    const error = await a.runtime.shutdown().then(() => null, (err: unknown) => err);

    // Honest terminal: failed, no recovery owner, no input replay obligation
    // (dispatch already happened — #3295 forbids replay after dispatch).
    expect(status(seq)).toBe('failed');
    expect(terminalRows(seq)).toEqual([
      { attempt_kind: 'failed', attempt_failure_class: 'crash', inbound_disposition: 'failed_terminal' },
    ]);
    expect(obligationStatuses(seq)).toEqual([]);
    // ...and the runtime phase reports the loss instead of claiming success.
    expect(error).not.toBeNull();
  });

  it.fails('T3b: when the durable handoff write fails, the undispatched turn stays failed_terminal and shutdown rejects', async () => {
    const a = startProcess({ plannedStopDrainMs: SHORT_DRAIN_MS } as PlannedStopOptions);
    const { session } = await arriveInFlight(a.runtime, a.engine, 'wamid-t3b-head', 't3b head question');
    const follower = await arriveQueuedBehind(a.runtime, a.engine, 'wamid-t3b-follower', 't3b follower question');
    vi.spyOn(a.engine.deferredTurns, 'enqueueDeferredObligation').mockImplementation(() => {
      throw new Error('injected: deferred obligation write failed');
    });

    const stopping = a.runtime.shutdown().then(() => null, (err: unknown) => err);
    // The head completes inside the bound, so the ONLY loss is the failed handoff.
    await TIMING(20);
    echoNextAnswer(a.engine, queueFor(dmJid), (db.raw.prepare(
      "SELECT seq FROM inbound_events WHERE message_id = 'wamid-t3b-head'",
    ).get() as { seq: number }).seq);
    session.emit({ type: 'result', text: 't3b head answer' });
    const error = await stopping;

    expect(status(follower)).toBe('failed');
    expect(terminalRows(follower)).toHaveLength(1);
    expect(terminalRows(follower)[0]!.inbound_disposition).toBe('failed_terminal');
    expect(obligationStatuses(follower)).toEqual([]);
    expect(a.engine.deferredTurns.enqueueDeferredObligation).toHaveBeenCalled();
    expect(error).not.toBeNull();
  });

  // ─── T4: no false clean-stop success through main's shutdown sequence ───

  it('T4: a shutdown that finalized a turn failed is `shutdown incomplete` (no `shutdown complete`, exit 1)', async () => {
    const a = startProcess({ plannedStopDrainMs: SHORT_DRAIN_MS } as PlannedStopOptions);
    const { seq } = await arriveInFlight(a.runtime, a.engine, 'wamid-t4', 't4 question');
    const log = { info: vi.fn(), error: vi.fn() };

    const outcome = await runShutdownSequence({
      auxiliaries: [],
      shutdownRuntime: () => a.runtime.shutdown(),
      shutdownTransport: () => {},
      markCleanExit: () => ({ persisted: true as const }),
      log,
    });

    expect(status(seq)).toBe('failed');
    expect(log.info.mock.calls.map((call) => call[1])).not.toContain('shutdown complete');
    expect(outcome.complete).toBe(false);
    expect(outcome.failedPhase).toBe('runtime');
    expect(shutdownExitCode('SIGTERM', outcome)).toBe(1);
  });

  it('T4 control: a shutdown with no turn in flight is complete and exits 0', async () => {
    const a = startProcess({ plannedStopDrainMs: SHORT_DRAIN_MS } as PlannedStopOptions);
    const log = { info: vi.fn(), error: vi.fn() };
    const outcome = await runShutdownSequence({
      auxiliaries: [],
      shutdownRuntime: () => a.runtime.shutdown(),
      shutdownTransport: () => {},
      markCleanExit: () => ({ persisted: true as const }),
      log,
    });
    expect(outcome.complete).toBe(true);
    expect(log.info.mock.calls.map((call) => call[1])).toContain('shutdown complete');
    expect(shutdownExitCode('SIGTERM', outcome)).toBe(0);
  });

  it('T4 queue-close: a queue no teardown owns that fails to close makes the stop fail, and turns already taken are still finalized', async () => {
    const a = startProcess({ plannedStopDrainMs: SHORT_DRAIN_MS } as PlannedStopOptions);
    await arriveInFlight(a.runtime, a.engine, 'wamid-t4q-head', 't4q head question');
    const follower = await arriveQueuedBehind(a.runtime, a.engine, 'wamid-t4q-follower', 't4q follower question');
    // A later per-chat queue whose close fails once, with no reset/kill teardown owning it.
    const failing = new TurnQueue();
    vi.spyOn(failing, 'closeAndTakePendingTurns').mockImplementationOnce(() => {
      throw new Error('injected: queue close failed');
    });
    (a.runtime as unknown as { perChatTurnQueues: Map<string, TurnQueue> })
      .perChatTurnQueues.set('t4q-unowned', failing);

    const error = await a.runtime.shutdown().then(() => null, (err: unknown) => err);

    // The follower was taken from the earlier queue and finalized, not dropped.
    expect(status(follower)).toBe('failed');
    expect(terminalRows(follower)).toHaveLength(1);
    expect(terminalRows(follower)[0]!.inbound_disposition).toBe('failed_terminal');
    // The close failure is reported; it is not absorbed as a teardown-owned queue.
    expect(error).toBeInstanceOf(AggregateError);
    const failures = (error as AggregateError).errors;
    expect(failures.some((failure) => failure instanceof PlannedStopQueueCloseError)).toBe(true);
  });

  it('T4 queue-close control: the same close failure with nothing in flight still makes the stop incomplete', async () => {
    const a = startProcess({ plannedStopDrainMs: SHORT_DRAIN_MS } as PlannedStopOptions);
    const failing = new TurnQueue();
    vi.spyOn(failing, 'closeAndTakePendingTurns').mockImplementationOnce(() => {
      throw new Error('injected: queue close failed');
    });
    (a.runtime as unknown as { perChatTurnQueues: Map<string, TurnQueue> })
      .perChatTurnQueues.set('t4q-unowned', failing);
    const log = { info: vi.fn(), error: vi.fn() };

    const outcome = await runShutdownSequence({
      auxiliaries: [],
      shutdownRuntime: () => a.runtime.shutdown(),
      shutdownTransport: () => {},
      markCleanExit: () => ({ persisted: true as const }),
      log,
    });

    expect(outcome.complete).toBe(false);
    expect(outcome.failedPhase).toBe('runtime');
    expect(log.info.mock.calls.map((call) => call[1])).not.toContain('shutdown complete');
    expect(shutdownExitCode('SIGTERM', outcome)).toBe(1);
  });

  // ─── T5: exactly-once across two starts ───

  it.fails('T5a: after a handoff, two consecutive starts dispatch the inbound exactly once in total', async () => {
    const a = startProcess({ plannedStopDrainMs: SHORT_DRAIN_MS } as PlannedStopOptions);
    await arriveInFlight(a.runtime, a.engine, 'wamid-t5a-head', 't5a head question');
    const follower = await arriveQueuedBehind(a.runtime, a.engine, 'wamid-t5a-follower', 't5a follower question');
    await a.runtime.shutdown().catch(() => {});

    const beforeB = sessionDoubles.length;
    const b = startProcess();
    await vi.waitFor(() => expect(dispatchesOf('t5a follower question', sessionDoubles.slice(beforeB))).toBe(1), { timeout: 3_000 });
    const session = sessionDoubles.slice(beforeB).find((candidate) => candidate.turnInFlight)!;
    echoNextAnswer(b.engine, queueFor(dmJid), follower);
    session.emit({ type: 'result', text: 't5a answer' });
    await vi.waitFor(() => expect(status(follower)).toBe('complete'), { timeout: 3_000 });
    await b.runtime.shutdown();

    const beforeC = sessionDoubles.length;
    startProcess();
    await TIMING(300);
    expect(dispatchesOf('t5a follower question', sessionDoubles.slice(beforeC))).toBe(0);
    expect(dispatchesOf('t5a follower question')).toBe(1);
    expect(obligationStatuses(follower)).toEqual(['terminal_completed']);
  });

  it.fails('T5b: a handed-off turn whose re-dispatch is interrupted is NOT dispatched again by the next start (dispatched_commit is final)', async () => {
    const a = startProcess({ plannedStopDrainMs: SHORT_DRAIN_MS } as PlannedStopOptions);
    await arriveInFlight(a.runtime, a.engine, 'wamid-t5b-head', 't5b head question');
    const follower = await arriveQueuedBehind(a.runtime, a.engine, 'wamid-t5b-follower', 't5b follower question');
    await a.runtime.shutdown().catch(() => {});

    const beforeB = sessionDoubles.length;
    const b = startProcess({ plannedStopDrainMs: SHORT_DRAIN_MS } as PlannedStopOptions);
    await vi.waitFor(() => expect(dispatchesOf('t5b follower question', sessionDoubles.slice(beforeB))).toBe(1), { timeout: 3_000 });
    // B is stopped while the re-dispatched turn is still with the provider.
    await b.runtime.shutdown().catch(() => {});
    expect(status(follower)).toBe('failed');

    const beforeC = sessionDoubles.length;
    startProcess();
    await TIMING(300);
    expect(dispatchesOf('t5b follower question', sessionDoubles.slice(beforeC))).toBe(0);
    expect(dispatchesOf('t5b follower question')).toBe(1);
    expect(obligationStatuses(follower)).not.toContain('pending');
    expect(obligationStatuses(follower)).not.toContain('claimed');
  });
});
