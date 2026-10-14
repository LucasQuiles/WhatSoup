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
// planned-stop drain and the loss report (planned-stop-drain.ts). T1, T3b, T5a
// and T5b are plain assertions behind the #3295 `deferredTurnAdmission` flag:
// the stop hands a queued, never-dispatched turn to the durable deferred-turn
// owner, and the S3 drain (deferred-turn-drain.ts) dispatches it on the next
// start, committing `dispatched_commit` before the turn is published or sent.
// T1b is a plain assertion: until the stop closes intake (before its
// message-handler drain), a journaled plain-text message runs the ordinary
// intake pipeline and its queue admission hands it off (cause `planned_stop`);
// the same message with an envelope the store refuses (e.g. over the byte
// bound) is already accepted, so it is a counted stop loss (ingest:
// `failed / pre_dispatch_error`, shutdown incomplete); after closure a message
// is refused with RuntimeAdmissionClosedError (ingest: `failed / queue_closed`). Ordinary queue-close / halt / full / unknown /
// processor-failure rejections stay terminal (T1 cause cases).
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

// Records every log call by component so the drain's content-free log
// contract (#3295 S3 privacy) can be asserted.
const { logCalls } = vi.hoisted(() => ({
  logCalls: [] as Array<{ component: string; level: string; args: unknown[] }>,
}));
vi.mock('../../../src/logger.ts', () => {
  const make = (component: string) => {
    const record = (level: string) => (...args: unknown[]): void => {
      logCalls.push({ component, level, args });
    };
    const logger = {
      info: record('info'), warn: record('warn'), error: record('error'),
      debug: record('debug'), fatal: record('fatal'), level: 'error',
    };
    return { ...logger, child: () => logger };
  };
  return { createChildLogger: (name: string) => make(name) };
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
import { createIngestHandler } from '../../../src/core/ingest.ts';
import { installFakePerChatMcpSocketManager } from './helpers/fake-per-chat-mcp-socket-manager.ts';
import { PlannedStopQueueCloseError, plannedStopIntakeDecision } from '../../../src/runtimes/agent/planned-stop-drain.ts';
import { TURN_RECOVERY_MAX_TEXT_BYTES } from '../../../src/core/turn-recovery-contract.ts';
import { PlannedStopIntakeLossError, RuntimeAdmissionClosedError, classifyErrorForInbound } from '../../../src/core/inbound-failure-class.ts';
import type { RuntimeTurnCoordinator } from '../../../src/runtimes/agent/runtime-turn-coordinator.ts';
import type { QueuedTurn } from '../../../src/runtimes/agent/turn-queue.ts';

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
 * The handoff and its drain live behind the #3295 `deferredTurnAdmission`
 * flag (default OFF). Every process generation of a handoff case opts in, so
 * the drain that dispatches the obligation runs on the next start. Cases
 * without it pin the flag-OFF behaviour (T3a, T4: the stop fails the turn).
 */
const HANDOFF: PlannedStopOptions = { deferredTurnAdmission: { enabled: true } };

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
    logCalls.length = 0;
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
    // Startup recovery and the runtime read the same deferredTurnAdmission
    // setting: the deferred owner is enabled exactly when the flag is.
    engine.preConnectRecovery({ deferredTurnOwnerEnabled: options.deferredTurnAdmission?.enabled === true });
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

  it('T1: a turn admitted behind an in-flight turn (after a quiet stop-check) is handed off, not failed, and the next start dispatches it exactly once', async () => {
    const a = startProcess({ ...HANDOFF, plannedStopDrainMs: SHORT_DRAIN_MS });
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
    const b = startProcess(HANDOFF);
    expect(status(follower)).toBe('processing');
    await vi.waitFor(() => expect(dispatchesOf('t1 follower question', sessionDoubles.slice(before))).toBe(1), { timeout: 3_000 });
    const session = sessionDoubles.slice(before).find((candidate) => candidate.turnInFlight)!;
    echoNextAnswer(b.engine, queueFor(dmJid), follower);
    session.emit({ type: 'result', text: 't1 follower answer' });
    await vi.waitFor(() => expect(status(follower)).toBe('complete'), { timeout: 3_000 });
    expect(obligationStatuses(follower)).toEqual(['terminal_completed']);
    expect(dispatchesOf('t1 follower question')).toBe(1);
  });

  it('T1b: a message handed to the runtime while shutdown is draining is handed off (not rejected / failed)', async () => {
    const a = startProcess({ ...HANDOFF, plannedStopDrainMs: SHORT_DRAIN_MS });
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

  it('T1b closure: once the runtime phase of the stop is over, a late message is rejected with a typed closed-admission error that ingest records as queue_closed', async () => {
    const a = startProcess(HANDOFF);
    await a.runtime.shutdown();
    const seq = a.engine.journalInbound('wamid-t1b-closed', conversationKey, dmJid, 'agent');
    const error = await a.runtime.handleMessage(makeMsg({ messageId: 'wamid-t1b-closed', content: 't1b closed', inboundSeq: seq }))
      .then(() => null, (err: unknown) => err);
    expect(error).toBeInstanceOf(RuntimeAdmissionClosedError);
    // ingest step 6 records a rejected journaled inbound with this class (honest, distinct from 'unknown').
    expect(classifyErrorForInbound(error)).toBe('queue_closed');
    expect(obligationStatuses(seq)).toEqual([]);
  });

  it('T1b envelope: during the stop, a journaled message the deferred owner could not store (text over the replay bound) is refused as a counted stop loss, never handed off or dispatched', async () => {
    const a = startProcess({ ...HANDOFF, plannedStopDrainMs: SHORT_DRAIN_MS });
    await arriveInFlight(a.runtime, a.engine, 'wamid-t1b-big-head', 't1b big head question');
    const stopping = a.runtime.shutdown().catch(() => {});
    const seq = a.engine.journalInbound('wamid-t1b-big', conversationKey, dmJid, 'agent');
    const oversize = 'x'.repeat(TURN_RECOVERY_MAX_TEXT_BYTES + 1);
    const error = await a.runtime.handleMessage(makeMsg({ messageId: 'wamid-t1b-big', content: oversize, inboundSeq: seq }))
      .then(() => null, (err: unknown) => err);
    await stopping;
    // Already journaled, so not a benign shed: ingest records it pre_dispatch_error and
    // the stop counts it (see the ingest-route case for the full pipeline).
    expect(error).toBeInstanceOf(PlannedStopIntakeLossError);
    expect(classifyErrorForInbound(error)).toBe('pre_dispatch_error');
    expect(obligationStatuses(seq)).toEqual([]);
    expect(terminalRows(seq)).toEqual([]);
    expect(dispatchesOf(oversize)).toBe(0);
  });

  it('T1b envelope bound: during the stop, a message exactly at the replay bound is still handed off (no-loss contract kept)', async () => {
    const a = startProcess({ ...HANDOFF, plannedStopDrainMs: SHORT_DRAIN_MS });
    await arriveInFlight(a.runtime, a.engine, 'wamid-t1b-edge-head', 't1b edge head question');
    const stopping = a.runtime.shutdown().catch(() => {});
    const seq = a.engine.journalInbound('wamid-t1b-edge', conversationKey, dmJid, 'agent');
    const atBound = 'y'.repeat(TURN_RECOVERY_MAX_TEXT_BYTES);
    const admitted = await a.runtime.handleMessage(makeMsg({ messageId: 'wamid-t1b-edge', content: atBound, inboundSeq: seq }))
      .then(() => 'accepted', () => 'rejected');
    await stopping;
    expect(admitted).toBe('accepted');
    expect(status(seq)).toBe('processing');
    expect(obligationStatuses(seq)).toEqual(['pending']);
  });

  it('T1b envelope: the planned-stop intake treats a replay-unsafe or missing envelope as unownable, and anything after closure as closed', () => {
    const base = {
      intakeClosed: false,
      deferredOwner: true,
      msg: { inboundSeq: 7, contentType: 'text' as const, isSyntheticJob: false },
      classification: 'message',
    };
    expect(plannedStopIntakeDecision({ ...base, replay: { replaySafe: true, text: 'fits' } })).toBe('admit');
    expect(plannedStopIntakeDecision({ ...base, replay: { replaySafe: false, text: 'fits' } })).toBe('unownable');
    expect(plannedStopIntakeDecision({ ...base, replay: { replaySafe: true, text: null } })).toBe('unownable');
    expect(plannedStopIntakeDecision({ ...base, intakeClosed: true, replay: { replaySafe: false, text: 'fits' } })).toBe('closed');
    expect(plannedStopIntakeDecision({ ...base, classification: 'local', replay: { replaySafe: true, text: 'fits' } })).toBe('closed');
  });

  it('T1b ingest route: an eligible oversize plain-text message that ingest journaled during the stop is an accounted stop loss, not a benign queue_closed rejection', async () => {
    // REAL ingest (createIngestHandler) in front of the REAL runtime: ingest
    // stores and journals the message (inboundSeq assigned) BEFORE
    // runtime.handleMessage, so a refusal there is past the acceptance boundary.
    const a = startProcess({ ...HANDOFF, plannedStopDrainMs: LONG_DRAIN_MS });
    const { seq: headSeq, session } = await arriveInFlight(a.runtime, a.engine, 'wamid-t1b-ingest-head', 't1b ingest head question');
    const log = { info: vi.fn(), error: vi.fn() };
    const stopping = runShutdownSequence({
      auxiliaries: [],
      shutdownRuntime: () => a.runtime.shutdown(),
      shutdownTransport: () => {},
      markCleanExit: () => ({ persisted: true as const }),
      log,
    });
    await vi.waitFor(() => expect((a.runtime as unknown as { shutdownRequested: boolean }).shutdownRequested).toBe(true));

    const ingest = createIngestHandler(db, makeMessenger(), a.runtime, () => '15550000@s.whatsapp.net', () => null, a.engine);
    const oversize = 'z'.repeat(TURN_RECOVERY_MAX_TEXT_BYTES + 1);
    ingest(makeMsg({ messageId: 'wamid-t1b-ingest-big', content: oversize }));
    const row = () => db.raw.prepare(
      'SELECT seq, processing_status, failure_class FROM inbound_events WHERE message_id = ?',
    ).get('wamid-t1b-ingest-big') as { seq: number; processing_status: string; failure_class: string | null } | undefined;
    // Accepted: ingest journaled it before the runtime refused it.
    await vi.waitFor(() => expect(row()?.processing_status).toBe('failed'), { timeout: 2_000 });

    // The head answers inside the drain bound, so the oversize message is the stop's only loss.
    echoNextAnswer(a.engine, queueFor(dmJid), headSeq);
    session.emit({ type: 'result', text: 't1b ingest head answer' });
    const outcome = await stopping;

    expect({
      failureClass: row()!.failure_class,
      stopComplete: outcome.complete,
      failedPhase: outcome.failedPhase,
      exitCode: shutdownExitCode('SIGTERM', outcome),
      shutdownCompleteLogged: log.info.mock.calls.map((call) => call[1]).includes('shutdown complete'),
    }).toEqual({
      // A fault class (not the benign capacity-shed queue_closed) on the accepted row.
      failureClass: 'pre_dispatch_error',
      // The stop lost accepted work it could not own: it must not report clean.
      stopComplete: false,
      failedPhase: 'runtime',
      exitCode: 1,
      shutdownCompleteLogged: false,
    });
    expect(status(headSeq)).toBe('complete');
    expect(obligationStatuses(row()!.seq)).toEqual([]);
    expect(dispatchesOf(oversize)).toBe(0);
  });

  // ─── T1 cause: only the planned stop hands off; ordinary exclusions stay terminal ───

  function coordinatorOf(runtime: AgentRuntime): RuntimeTurnCoordinator {
    return (runtime as unknown as { runtimeTurnCoordinator: RuntimeTurnCoordinator }).runtimeTurnCoordinator;
  }

  /** A journaled, admitted, never-dispatched per_chat text turn (replay-safe envelope). */
  function admittedTurn(a: { runtime: AgentRuntime; engine: DurabilityEngine }, messageId: string, content: string) {
    const seq = a.engine.journalInbound(messageId, conversationKey, dmJid, 'agent');
    const runtime = a.runtime as unknown as {
      resolvePerChatMapKey(jid: string): string;
      ensureSessionAndQueueSync(jid: string, mapKey: string): void;
      chatSessions: Map<string, unknown>;
      requireSessionToolScopeKey(session: unknown): string;
    };
    const mapKey = runtime.resolvePerChatMapKey(dmJid);
    runtime.ensureSessionAndQueueSync(dmJid, mapKey);
    const session = runtime.chatSessions.get(mapKey);
    const source = {
      sourceMessageId: messageId,
      receivedAtUnixSeconds: Math.floor(Date.now() / 1000),
      conversationKey,
      senderJid,
      senderName: 'Test User',
      contentType: 'text' as const,
      isGroup: false,
    };
    const runtimeContext = coordinatorOf(a.runtime).createRuntimeTurnForDispatch({
      scope: 'per_chat', chatJid: dmJid, text: content, inboundSeq: seq, source,
      session: session as never, toolScopeKey: runtime.requireSessionToolScopeKey(session), mapKey,
    })!;
    const turn: QueuedTurn = { ...source, chatJid: dmJid, text: content, runtimeContext, inboundSeq: seq };
    return { seq, mapKey, turn };
  }

  it.each([
    ['generic queue close', 'queue_closed'],
    ['queue halted', 'queue_halted'],
    ['queue full', 'queue_full'],
    ['unknown rejection', undefined],
  ] as const)('T1 cause: %s during a planned stop stays terminal and is never handed off', async (_label, reason) => {
    const a = startProcess(HANDOFF);
    // A planned stop is in progress: the handoff must still key on its own cause, not on the stop state.
    (a.runtime as unknown as { shutdownRequested: boolean }).shutdownRequested = true;
    const { seq, turn } = admittedTurn(a, `wamid-cause-${reason ?? 'unknown'}`, 'cause question');

    coordinatorOf(a.runtime).finalizeRejectedRuntimeTurn(turn, reason);
    await coordinatorOf(a.runtime).awaitRejectedRuntimeTurnFinalizations();

    expect(status(seq)).toBe('failed');
    expect(terminalRows(seq)).toHaveLength(1);
    expect(terminalRows(seq)[0]!.inbound_disposition).toBe('failed_terminal');
    expect(obligationStatuses(seq)).toEqual([]);
  });

  it('T1 cause: a processor failure during a planned stop stays terminal and is never handed off', async () => {
    const a = startProcess(HANDOFF);
    (a.runtime as unknown as { shutdownRequested: boolean }).shutdownRequested = true;
    const { seq, mapKey, turn } = admittedTurn(a, 'wamid-cause-processor', 'cause processor question');

    await coordinatorOf(a.runtime).finalizePerChatProcessorError(mapKey, turn, new Error('injected: processor failed'));

    expect(status(seq)).toBe('failed');
    expect(terminalRows(seq)).toHaveLength(1);
    expect(terminalRows(seq)[0]!.inbound_disposition).toBe('failed_terminal');
    expect(obligationStatuses(seq)).toEqual([]);
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

  it('T3b: when the durable handoff write fails, the undispatched turn stays failed_terminal and shutdown rejects', async () => {
    const a = startProcess({ ...HANDOFF, plannedStopDrainMs: SHORT_DRAIN_MS });
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

  it('T5a: after a handoff, two consecutive starts dispatch the inbound exactly once in total', async () => {
    const a = startProcess({ ...HANDOFF, plannedStopDrainMs: SHORT_DRAIN_MS });
    await arriveInFlight(a.runtime, a.engine, 'wamid-t5a-head', 't5a head question');
    const follower = await arriveQueuedBehind(a.runtime, a.engine, 'wamid-t5a-follower', 't5a follower question');
    await a.runtime.shutdown().catch(() => {});

    const beforeB = sessionDoubles.length;
    const b = startProcess(HANDOFF);
    await vi.waitFor(() => expect(dispatchesOf('t5a follower question', sessionDoubles.slice(beforeB))).toBe(1), { timeout: 3_000 });
    const session = sessionDoubles.slice(beforeB).find((candidate) => candidate.turnInFlight)!;
    echoNextAnswer(b.engine, queueFor(dmJid), follower);
    session.emit({ type: 'result', text: 't5a answer' });
    await vi.waitFor(() => expect(status(follower)).toBe('complete'), { timeout: 3_000 });
    await b.runtime.shutdown();

    const beforeC = sessionDoubles.length;
    startProcess(HANDOFF);
    await TIMING(300);
    expect(dispatchesOf('t5a follower question', sessionDoubles.slice(beforeC))).toBe(0);
    expect(dispatchesOf('t5a follower question')).toBe(1);
    expect(obligationStatuses(follower)).toEqual(['terminal_completed']);
  });

  it('T5b: a handed-off turn whose re-dispatch is interrupted is NOT dispatched again by the next start (dispatched_commit is final)', async () => {
    const a = startProcess({ ...HANDOFF, plannedStopDrainMs: SHORT_DRAIN_MS });
    await arriveInFlight(a.runtime, a.engine, 'wamid-t5b-head', 't5b head question');
    const follower = await arriveQueuedBehind(a.runtime, a.engine, 'wamid-t5b-follower', 't5b follower question');
    await a.runtime.shutdown().catch(() => {});

    const beforeB = sessionDoubles.length;
    const b = startProcess({ ...HANDOFF, plannedStopDrainMs: SHORT_DRAIN_MS });
    await vi.waitFor(() => expect(dispatchesOf('t5b follower question', sessionDoubles.slice(beforeB))).toBe(1), { timeout: 3_000 });
    // B is stopped while the re-dispatched turn is still with the provider.
    await b.runtime.shutdown().catch(() => {});
    expect(status(follower)).toBe('failed');

    const beforeC = sessionDoubles.length;
    startProcess(HANDOFF);
    await TIMING(300);
    expect(dispatchesOf('t5b follower question', sessionDoubles.slice(beforeC))).toBe(0);
    expect(dispatchesOf('t5b follower question')).toBe(1);
    expect(obligationStatuses(follower)).not.toContain('pending');
    expect(obligationStatuses(follower)).not.toContain('claimed');
  });

  // ─── #3295 S3: the deferred-turn drain (fencing, kill switch, blockers) ───

  /** A durable obligation as a prior generation left it: journaled inbound + pending row. */
  function seedObligation(messageId: string, content: string): number {
    const engine = new DurabilityEngine(db);
    const seq = engine.journalInbound(messageId, conversationKey, dmJid, 'agent');
    engine.deferredTurns.enqueueDeferredObligation({
      scope: 'per_chat',
      conversationKey,
      deliveryJid: dmJid,
      inboundSeq: seq,
      sourceMessageId: messageId,
      receivedAtUnixSeconds: Math.floor(Date.now() / 1000),
      replaySafe: true,
      senderJid,
      senderName: 'Test User',
      text: content,
      isGroup: false,
      contentType: 'text',
    });
    return seq;
  }

  function obligationRow(seq: number) {
    return db.raw.prepare(
      'SELECT status, attempt_count, terminal_reason FROM deferred_turn_obligations WHERE inbound_seq = ?',
    ).get(seq) as { status: string; attempt_count: number; terminal_reason: string | null };
  }

  function kickDrain(runtime: AgentRuntime): void {
    (runtime as unknown as { deferredTurnDrain: { kick(): void } }).deferredTurnDrain.kick();
  }

  it('S3 concurrency: two processes draining the same database dispatch an obligation once', async () => {
    const seq = seedObligation('wamid-s3-race', 's3 race question');
    startProcess(HANDOFF);
    startProcess(HANDOFF);

    await vi.waitFor(() => expect(dispatchesOf('s3 race question')).toBe(1), { timeout: 3_000 });
    await TIMING(300);
    expect(dispatchesOf('s3 race question')).toBe(1);
    // One claim, committed before the provider send.
    expect(obligationRow(seq)).toMatchObject({ status: 'dispatched_commit', attempt_count: 1 });
  });

  it('S3 kill switch at startup: with the flag OFF the owned inbound is closed honestly, never left processing and never dispatched', async () => {
    const seq = seedObligation('wamid-s3-kill-start', 's3 kill start question');
    const options = { deferredTurnAdmission: { enabled: false } };
    const b = startProcess(options);

    await TIMING(300);
    expect(dispatchesOf('s3 kill start question')).toBe(0);
    // No owner runs while the flag is off: crash recovery fails the inbound
    // (no silent processing row) and closes the pre-commit obligation.
    expect(status(seq)).toBe('failed');
    expect(obligationRow(seq)).toMatchObject({ status: 'terminal_quarantined', terminal_reason: 'owner_disabled' });

    options.deferredTurnAdmission.enabled = true;
    kickDrain(b.runtime);
    await TIMING(300);
    expect(dispatchesOf('s3 kill start question')).toBe(0);
  });

  it('S3 kill switch: with the flag turned OFF live the drain neither claims nor dispatches; turning it ON drains once', async () => {
    const seq = seedObligation('wamid-s3-kill', 's3 kill question');
    const options = { deferredTurnAdmission: { enabled: true } };
    const b = startProcess(options);
    // Turned off before the first pass (it runs on a timer turn), after the
    // startup recovery that ran with the owner enabled.
    options.deferredTurnAdmission.enabled = false;
    kickDrain(b.runtime);

    await TIMING(300);
    expect(dispatchesOf('s3 kill question')).toBe(0);
    expect(status(seq)).toBe('processing');
    expect(obligationRow(seq)).toMatchObject({ status: 'pending', attempt_count: 0 });

    options.deferredTurnAdmission.enabled = true;
    kickDrain(b.runtime);
    await vi.waitFor(() => expect(dispatchesOf('s3 kill question')).toBe(1), { timeout: 3_000 });
    const session = sessionDoubles.find((candidate) => candidate.turnInFlight)!;
    echoNextAnswer(b.engine, queueFor(dmJid), seq);
    session.emit({ type: 'result', text: 's3 kill answer' });
    await vi.waitFor(() => expect(status(seq)).toBe('complete'), { timeout: 3_000 });
    await vi.waitFor(() => expect(obligationRow(seq)).toMatchObject({
      status: 'terminal_completed',
      terminal_reason: 'completed',
    }), { timeout: 3_000 });
  });

  it('S3 blocker: an outstanding same-scope recovery holds the obligation unclaimed; it drains once the blocker clears', async () => {
    const seq = seedObligation('wamid-s3-blocked', 's3 blocked question');
    const b = startProcess(HANDOFF);
    const blocked = vi.spyOn(b.engine, 'hasOutstandingTurnRecoveryForScope').mockReturnValue(true);

    await TIMING(300);
    expect(blocked).toHaveBeenCalledWith('per_chat', conversationKey);
    expect(dispatchesOf('s3 blocked question')).toBe(0);
    expect(obligationRow(seq)).toMatchObject({ status: 'pending', attempt_count: 0 });

    blocked.mockReturnValue(false);
    kickDrain(b.runtime);
    await vi.waitFor(() => expect(dispatchesOf('s3 blocked question')).toBe(1), { timeout: 3_000 });
    expect(obligationRow(seq)).toMatchObject({ status: 'dispatched_commit', attempt_count: 1 });
  });

  it('S3 stale claim: a pre-commit claim left by a dead process is reclaimed and dispatched once', async () => {
    const seq = seedObligation('wamid-s3-stale', 's3 stale question');
    // The dead process claimed but never committed; its claim has expired.
    new DurabilityEngine(db).deferredTurns.claimNextEligible('per_chat', {
      conversationKey,
      claimToken: 'dead-process-claim',
      ttlSeconds: -1,
    });

    startProcess(HANDOFF);
    expect(status(seq)).toBe('processing');
    await vi.waitFor(() => expect(dispatchesOf('s3 stale question')).toBe(1), { timeout: 3_000 });
    await TIMING(300);
    expect(dispatchesOf('s3 stale question')).toBe(1);
    expect(obligationRow(seq)).toMatchObject({ status: 'dispatched_commit', attempt_count: 2 });
  });

  it('S3 retry: a failure before the provider boundary requeues the claim (attempt counted) and a later pass dispatches once', async () => {
    const seq = seedObligation('wamid-s3-retry', 's3 retry question');
    const b = startProcess(HANDOFF);
    const coordinator = (b.runtime as unknown as {
      runtimeTurnCoordinator: { createRuntimeTurnForDispatch: (...args: unknown[]) => unknown };
    }).runtimeTurnCoordinator;
    vi.spyOn(coordinator, 'createRuntimeTurnForDispatch').mockImplementationOnce(() => {
      throw new Error('injected: no owned session yet');
    });

    await vi.waitFor(() => expect(obligationRow(seq)).toMatchObject({ status: 'pending', attempt_count: 1 }), { timeout: 3_000 });
    expect(dispatchesOf('s3 retry question')).toBe(0);
    expect(status(seq)).toBe('processing');

    kickDrain(b.runtime);
    await vi.waitFor(() => expect(dispatchesOf('s3 retry question')).toBe(1), { timeout: 3_000 });
    expect(obligationRow(seq)).toMatchObject({ status: 'dispatched_commit', attempt_count: 2 });
  });

  it('S3 settled source: an obligation whose inbound another owner already failed is quarantined, never dispatched', async () => {
    const seq = seedObligation('wamid-s3-settled', 's3 settled question');
    new DurabilityEngine(db).markInboundFailed(seq);

    startProcess(HANDOFF);
    await vi.waitFor(() => expect(obligationRow(seq)).toMatchObject({
      status: 'terminal_quarantined',
      terminal_reason: 'source_not_open',
    }), { timeout: 3_000 });
    expect(dispatchesOf('s3 settled question')).toBe(0);
  });

  /** Wrap the next constructed session's spawn (pre-boundary) with `beforeSpawn`. */
  function onNextSpawn(beforeSpawn: () => Promise<void> | void): void {
    sessionConstructHooks.push((double) => {
      const spawn = double.spawnSession.getMockImplementation()!;
      double.spawnSession.mockImplementation(async () => {
        await beforeSpawn();
        await spawn();
      });
    });
  }

  function perChatTurnQueuesIdle(runtime: AgentRuntime): boolean {
    const queues = (runtime as unknown as { perChatTurnQueues: Map<string, TurnQueue> }).perChatTurnQueues;
    return [...queues.values()].every((queue) => !queue.isProcessing);
  }

  it('S3 stale fence at the provider boundary: the provider is not called, the source stays open and the obligation stays recoverable', async () => {
    const seq = seedObligation('wamid-s3-fence', 's3 fence question');
    let spawned = false;
    // While the drained turn waits for its session (before the boundary), its
    // claim expires and another drain resets it: the fence this turn holds is stale.
    onNextSpawn(() => {
      db.raw.prepare(
        "UPDATE deferred_turn_obligations SET claim_expires_at = datetime('now', '-1 seconds') WHERE inbound_seq = ?",
      ).run(seq);
      new DurabilityEngine(db).deferredTurns.expireStaleClaims('per_chat');
      spawned = true;
    });
    const b = startProcess(HANDOFF);

    await vi.waitFor(() => expect(spawned).toBe(true), { timeout: 3_000 });
    await vi.waitFor(() => expect(perChatTurnQueuesIdle(b.runtime)).toBe(true), { timeout: 3_000 });
    expect(sessionDoubles.flatMap((session) => session.sendTurn.mock.calls)).toHaveLength(0);
    expect(dispatchesOf('s3 fence question')).toBe(0);
    expect(status(seq)).toBe('processing');
    expect(terminalRows(seq)).toEqual([]);
    expect(obligationRow(seq)).toMatchObject({ status: 'pending', attempt_count: 1 });

    // Recoverable: the next pass claims it and dispatches it once.
    kickDrain(b.runtime);
    await vi.waitFor(() => expect(dispatchesOf('s3 fence question')).toBe(1), { timeout: 3_000 });
    expect(obligationRow(seq)).toMatchObject({ status: 'dispatched_commit', attempt_count: 2 });
  });

  it('S3 post-commit failure: the obligation closes quarantined (source_failed), never completed, and is never replayed', async () => {
    const seq = seedObligation('wamid-s3-postfail', 's3 postfail question');
    const b = startProcess(HANDOFF);
    await vi.waitFor(() => expect(dispatchesOf('s3 postfail question')).toBe(1), { timeout: 3_000 });
    expect(obligationRow(seq)).toMatchObject({ status: 'dispatched_commit' });

    sessionDoubles.find((candidate) => candidate.turnInFlight)!.failProviderTurn(new Error('injected: provider child died'));

    await vi.waitFor(() => expect(status(seq)).toBe('failed'), { timeout: 3_000 });
    await vi.waitFor(() => expect(obligationRow(seq)).toMatchObject({
      status: 'terminal_quarantined',
      terminal_reason: 'source_failed',
    }), { timeout: 3_000 });
    kickDrain(b.runtime);
    await TIMING(200);
    expect(dispatchesOf('s3 postfail question')).toBe(1);
  });

  it('S3 FIFO: an older durable obligation dispatches before a fresh live message of the same chat', async () => {
    const older = seedObligation('wamid-s3-fifo-old', 's3 fifo older question');
    const b = startProcess(HANDOFF);
    // The live message reaches the runtime before the drain's first pass (a timer turn).
    const live = await arrive(b.runtime, b.engine, 'wamid-s3-fifo-live', 's3 fifo live question');

    await vi.waitFor(() => expect(
      dispatchesOf('s3 fifo older question') + dispatchesOf('s3 fifo live question'),
    ).toBeGreaterThan(0), { timeout: 3_000 });
    expect(dispatchesOf('s3 fifo older question')).toBe(1);
    expect(dispatchesOf('s3 fifo live question')).toBe(0);

    echoNextAnswer(b.engine, queueFor(dmJid), older);
    sessionDoubles.find((candidate) => candidate.turnInFlight)!.emit({ type: 'result', text: 'older answer' });
    await vi.waitFor(() => expect(status(older)).toBe('complete'), { timeout: 3_000 });
    await vi.waitFor(() => expect(dispatchesOf('s3 fifo live question')).toBe(1), { timeout: 3_000 });
    expect(dispatchesOf('s3 fifo older question')).toBe(1);
    expect(status(live)).toBe('processing');
  });

  it('S3 stop during a drained turn: a drained turn that has not reached the provider is handed back, the stop is clean, and the next start dispatches it once', async () => {
    const seq = seedObligation('wamid-s3-stop', 's3 stop question');
    let spawning = false;
    // The drained turn's session spawn is still running when the stop lands.
    onNextSpawn(() => {
      spawning = true;
      return new Promise<void>(() => {});
    });
    const b = startProcess({ ...HANDOFF, plannedStopDrainMs: SHORT_DRAIN_MS });
    await vi.waitFor(() => expect(spawning).toBe(true), { timeout: 3_000 });
    expect(obligationRow(seq)).toMatchObject({ status: 'claimed' });

    const stopped = await b.runtime.shutdown().then(() => null, (err: unknown) => err);

    expect(stopped).toBeNull();
    expect(status(seq)).toBe('processing');
    expect(terminalRows(seq)).toEqual([]);
    expect(obligationRow(seq)).toMatchObject({ status: 'pending' });

    const before = sessionDoubles.length;
    startProcess(HANDOFF);
    await vi.waitFor(() => expect(dispatchesOf('s3 stop question', sessionDoubles.slice(before))).toBe(1), { timeout: 3_000 });
    expect(dispatchesOf('s3 stop question')).toBe(1);
  });

  it('S3 privacy: drain logs carry no raw error, obligation id or inbound sequence', async () => {
    const canary = 'canary-raw-error-text-7f3a';
    const seq = seedObligation('wamid-s3-privacy', 's3 privacy question');
    const b = startProcess(HANDOFF);
    const coordinator = coordinatorOf(b.runtime) as unknown as {
      createRuntimeTurnForDispatch: (...args: unknown[]) => unknown;
    };
    vi.spyOn(coordinator, 'createRuntimeTurnForDispatch').mockImplementationOnce(() => {
      throw new Error(canary);
    });
    await vi.waitFor(() => expect(obligationRow(seq)).toMatchObject({ status: 'pending', attempt_count: 1 }), { timeout: 3_000 });
    kickDrain(b.runtime);
    await vi.waitFor(() => expect(obligationRow(seq)).toMatchObject({ status: 'dispatched_commit' }), { timeout: 3_000 });

    const drainLogs = logCalls.filter((call) => call.component === 'deferred-turn-drain');
    expect(drainLogs.length).toBeGreaterThan(0);
    for (const call of drainLogs) {
      for (const arg of call.args) {
        expect(arg).not.toBeInstanceOf(Error);
        if (arg !== null && typeof arg === 'object') {
          expect(Object.keys(arg)).not.toContain('err');
          expect(Object.keys(arg)).not.toContain('obligationId');
          expect(Object.keys(arg)).not.toContain('inboundSeq');
          for (const value of Object.values(arg)) expect(value).not.toBeInstanceOf(Error);
        }
      }
      expect(JSON.stringify(call.args)).not.toContain(canary);
    }
  });
});
