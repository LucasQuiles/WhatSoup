// LID chats: the inbound row terminal finalization checks must match the turn.
//
// Every durable artifact of a turn (turn identity, outbound ops, terminal
// record) is checked against the inbound row the turn was journaled under. A
// mapped @lid chat keys under the resolved PHONE digits and an unmapped one
// under the LID number, and a mapping can be written between the journal write
// and the turn's identity read. So whoever journals the row (the scheduled-job
// dispatcher, ingest) hands the exact journal key to the turn, a coalesced
// image turn takes its identity from the image whose row it represents, an
// alias migration of an open image buffer keeps that image's journaled chat
// JID, and a wedged lane is matched to the reclaimed row by its sequence.
//
// Harness: REAL AgentRuntime + REAL SQLite durability + REAL ingest; only the
// provider boundary and the outbound transport are doubled (the pattern of
// scheduled-turn-lifecycle.test.ts and deferred-turn-admission.test.ts). The
// queue double writes REAL outbound_ops rows under the runtime-supplied
// conversation key and its current delivery JID.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Messenger, IncomingMessage } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type { TurnQueue } from '../../../src/runtimes/agent/turn-queue.ts';
import { toConversationKey } from '../../../src/core/conversation-key.ts';
import { canonicalConversationKey } from '../../../src/core/access-list.ts';

// ─── Hoisted per-construction provider-boundary doubles ─────────────────────

const { sessionDoubles, queueDoubles, resetDoubles, makeSessionDouble, makeQueueDouble, harnessRef } = vi.hoisted(() => {
  // Set per test (beforeEach) so queue doubles can mint REAL durable outbound
  // ops: inbound completion legitimately requires echoed delivery evidence
  // (turn-finalizer.ts deriveDeliveryEvidence), so the double must write real
  // outbound_ops rows instead of returning fabricated op ids.
  const harnessRef: {
    current: {
      createEchoedTerminalOp: (conversationKey: string, chatJid: string, sourceInboundSeq: number | undefined, text: string) => number;
      /** 'pending' leaves answer ops unechoed, so an answered turn transfers to a recovery owner. */
      answerOpStatus: 'echoed' | 'pending';
    } | null;
  } = { current: null };
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
      /** Provider turn inputs, in dispatch order. */
      turnsSent: [] as unknown[],
      /** True while a dispatched provider turn has not terminalized. */
      get turnInFlight(): boolean {
        return pendingResolve !== null;
      },
      emit(event: AgentEvent): void {
        opts.onEvent(event);
      },
      spawnSession: vi.fn(async () => {
        active = true;
      }),
      // Real contract (session.ts): sendTurn resolves when the provider turn
      // TERMINALIZES (completeProviderTurn), not when the stdin write returns.
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
      })),
      shutdown: vi.fn(async () => {
        active = false;
      }),
      // Present so the wedged-lane release's intentional-kill step is
      // OBSERVABLE (the real SessionManager reaps a live provider child here).
      // Kills nothing, but reports the real method's return contract: `true`
      // is the ordinary real-process wedge (a child was killed). The
      // managed-provider cases override it with `false`, which is what the
      // real session returns when it holds no child at all (#3374 C7).
      reapWedgedProviderChild: vi.fn(() => true),
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
    let currentInboundSeq: number | undefined;
    let answerOpIds: number[] = [];
    // Like the real queue (outbound-queue.ts:1381-1383), the durable key is
    // fixed at creation and the delivery JID follows updateDeliveryJid.
    let deliveryJid = chatJid;
    const double = {
      targetChatJid: chatJid,
      enqueueText: vi.fn(),
      getSenderToken: () => 'test-sender-token',
      enqueueStreamingText: vi.fn(),
      commitStreamingText: vi.fn(),
      discardPreToolAssistantText: vi.fn(),
      // Result text becomes a REAL durable outbound op marked echoed — the
      // delivery-evidence contract the finalizer verifies against SQLite.
      enqueueResultText: vi.fn((text: string) => {
        const harness = harnessRef.current;
        if (!harness) throw new Error('queue double used before harness init');
        answerOpIds.push(
          harness.createEchoedTerminalOp(conversationKey, deliveryJid, currentInboundSeq, text),
        );
      }),
      enqueueToolUpdate: vi.fn(),
      enqueueProgressUpdate: vi.fn(),
      indicateTyping: vi.fn(),
      flush: vi.fn(async () => {}),
      isPoisoned: vi.fn(() => false),
      shutdown: vi.fn(async () => {}),
      abortTurn: vi.fn(),
      updateDeliveryJid: vi.fn((jid: string) => {
        deliveryJid = jid;
      }),
      setInboundSeq: vi.fn((seq: number | undefined) => {
        currentInboundSeq = seq;
      }),
      markLastTerminal: vi.fn(),
      clearLastOpId: vi.fn(),
      beginTurnEvidence: vi.fn(),
      flushTurnEvidence: vi.fn(async (turnId: string) => {
        const flushed = answerOpIds;
        answerOpIds = [];
        return {
          turnId,
          answerOpIds: flushed,
          lifecycleOpIds: [],
          statusOpIds: [],
        };
      }),
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

  return { sessionDoubles, queueDoubles, resetDoubles, makeSessionDouble, makeQueueDouble, harnessRef };
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
    stateRoot: `/tmp/whatsoup-test-state-sched-lid-${process.pid}`,
    restartLoopGuard: { enabled: true, maxRestarts: 3, windowMs: 300_000 },
    startupNotifications: false,
    proactiveResumeOnStartup: false,
    mediaDir: `/tmp/whatsoup-test-media-sched-lid-${process.pid}`,
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
  emitAlertChecked: vi.fn(),
  emitObservationChecked: vi.fn(() => true),
  clearAlertSource: vi.fn(),
  clearAlertSourceChecked: vi.fn(),
}));

// Partial: ingest stores real message rows (storeMessageIfNew stays real).
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
    onCrash?: (info: unknown) => void;
    notifyUser?: (msg: string) => void;
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
import { createIngestHandler } from '../../../src/core/ingest.ts';
import { upsertLidMapping } from '../../../src/core/lid-resolver.ts';
import { AgentRuntime, type AgentRuntimeOptions } from '../../../src/runtimes/agent/runtime.ts';
import { emitAlert, emitAlertChecked } from '../../../src/lib/emit-alert.ts';
import { installFakePerChatMcpSocketManager } from './helpers/fake-per-chat-mcp-socket-manager.ts';
import { drainIngest } from '../../core/_helpers/ingest-drain.ts';

// ─── Shared fixtures (synthetic identities only) ────────────────────────────

const LID_LOCAL = '900000000000042';
const LID_JID = `${LID_LOCAL}@lid`;
const PHONE_DIGITS = '15550004242';
const PHONE_JID = `${PHONE_DIGITS}@s.whatsapp.net`;
const SCHEDULED_PROMPT_MARK = '[isolated scheduled background turn]';
const FINALIZATION_ALERT = 'agent_turn_finalization_failed';
const ADMISSION_REJECTED_ALERT = 'agent_turn_admission_rejected';
const WEDGE_RELEASE_ALERT = 'agent_wedged_turn_released';
const COALESCE_WAIT = { timeout: 4_000, interval: 10 };

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

/** An inbound DM as the transport hands it to ingest. */
function customerMsg(
  chatJid: string,
  messageId: string,
  opts: { content?: string; contentType?: 'text' | 'image' } = {},
): IncomingMessage {
  return {
    messageId,
    chatJid,
    senderJid: chatJid,
    senderName: 'Customer',
    content: opts.content ?? 'hello',
    contentText: null,
    contentType: opts.contentType ?? 'text',
    isFromMe: false,
    isGroup: false,
    mentionedJids: [],
    timestamp: Math.floor(Date.now() / 1000),
    quotedMessageId: null,
    isResponseWorthy: true,
  };
}

/**
 * The access replay's runtime.handleMessage literal (src/main.ts:1000-1014),
 * handed to the runtime directly: no inboundSeq and no journaled key.
 */
function replayMsg(
  chatJid: string,
  messageId: string,
  opts: { content?: string; contentType?: 'text' | 'image' } = {},
): IncomingMessage {
  return customerMsg(chatJid, messageId, opts);
}

function turnText(input: unknown): string {
  if (typeof input === 'string') return input;
  const structured = input as { userText?: string; applicationContext?: readonly string[] };
  return [structured.applicationContext?.join('\n') ?? '', structured.userText ?? ''].join('\n');
}

type SessionDouble = (typeof sessionDoubles)[number];
type QueueDouble = (typeof queueDoubles)[number];

async function waitForScheduledTurn(timeout = 4_000): Promise<SessionDouble> {
  let found: SessionDouble | undefined;
  await vi.waitFor(() => {
    found = sessionDoubles.find(
      (s) => s.turnInFlight && s.turnsSent.some((t) => turnText(t).includes(SCHEDULED_PROMPT_MARK)),
    );
    expect(found).toBeDefined();
  }, { timeout });
  return found!;
}

/** The session whose in-flight provider turn is the one whose text matches. */
async function waitForInFlightTurn(matches: (text: string) => boolean, timeout = 4_000): Promise<SessionDouble> {
  let found: SessionDouble | undefined;
  await vi.waitFor(() => {
    found = sessionDoubles.find((s) => s.turnInFlight && matches(turnText(s.turnsSent.at(-1))));
    expect(found).toBeDefined();
  }, { timeout });
  return found!;
}

/**
 * A turn that ends with no answer op. '.' is suppressed either way: as
 * scheduled-job plain text on a scheduled lane (runtime.ts:2482) and as NOOP
 * text on a customer lane (:2545-2546), so the outcome is suppressed_by_policy.
 */
function suppressReply(session: SessionDouble): void {
  session.emit({ type: 'assistant_text', text: '.' });
  session.emit({ type: 'result', text: null });
}

function alertCalls(source: string): unknown[][] {
  return [
    ...vi.mocked(emitAlert).mock.calls,
    ...vi.mocked(emitAlertChecked).mock.calls,
  ].filter((call) => (call as unknown[]).includes(source)) as unknown[][];
}

function finalizationAlertCalls(): unknown[][] {
  return alertCalls(FINALIZATION_ALERT);
}

function admissionRejectedCalls(): unknown[][] {
  return alertCalls(ADMISSION_REJECTED_ALERT);
}

describe('scheduled agent job reporting to a mapped @lid chat', () => {
  let db: Database;
  let engine: DurabilityEngine;
  let runtime: AgentRuntime | undefined;
  let finalizeErrors: string[];
  let finalizeCalls: Array<Parameters<DurabilityEngine['finalizeTurnTerminal']>[0]>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDoubles();
    db = new Database(':memory:');
    db.open();
    db.raw.prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)').run(LID_LOCAL, PHONE_JID);
    engine = new DurabilityEngine(db);
    finalizeErrors = [];
    finalizeCalls = [];
    const finalize = engine.finalizeTurnTerminal.bind(engine);
    vi.spyOn(engine, 'finalizeTurnTerminal').mockImplementation((params) => {
      // Recorded first, so a call that throws is still visible.
      finalizeCalls.push(params);
      try {
        return finalize(params);
      } catch (err) {
        finalizeErrors.push(err instanceof Error ? err.message : String(err));
        throw err;
      }
    });
    harnessRef.current = {
      answerOpStatus: 'echoed',
      createEchoedTerminalOp: (conversationKey, chatJid, sourceInboundSeq, text) => {
        const opId = engine.createOutboundOp({
          conversationKey,
          chatJid,
          opType: 'text',
          payload: JSON.stringify({ text }),
          replayPolicy: 'safe',
          ...(sourceInboundSeq === undefined ? {} : { sourceInboundSeq }),
          isTerminal: true,
        });
        // 'pending' leaves the delivery unresolved.
        if (harnessRef.current?.answerOpStatus !== 'pending') {
          db.raw.prepare(`UPDATE outbound_ops SET status = 'echoed', echoed_at = datetime('now') WHERE id = ?`).run(opId);
        }
        return opId;
      },
    };
  });

  afterEach(async () => {
    for (const session of sessionDoubles) {
      if (session.turnInFlight) session.emit({ type: 'result', text: 'NO_REPLY' });
    }
    // A failed finalization leaves the turn supervisor retaining the scope, so
    // shutdown may reject on the unfixed path; the test body owns that verdict.
    await runtime?.shutdown().catch(() => undefined);
    runtime = undefined;
    db.close();
  });

  function makeRuntime(options: AgentRuntimeOptions): AgentRuntime {
    const created = new AgentRuntime(db, makeMessenger(), 'test', options);
    installFakePerChatMcpSocketManager(created);
    created.setDurability(engine);
    runtime = created;
    return created;
  }

  /** Real ingest in front of the runtime (the deferred-turn-admission.test.ts pattern). */
  function makeIngest(agent: AgentRuntime): (msg: IncomingMessage) => void {
    return createIngestHandler(db, makeMessenger(), agent, () => '15550000@s.whatsapp.net', () => null, engine);
  }

  function live(): AgentRuntime {
    if (!runtime) throw new Error('runtime not created');
    return runtime;
  }

  function dispatchJob(agent: AgentRuntime): number {
    const ack = agent.dispatchAgentJob({
      beadId: 7,
      triggerId: 5,
      occurrenceId: 11,
      prompt: 'Summarize the overnight queue.',
      title: 'Overnight summary',
      reportChatJid: LID_JID,
    });
    expect(ack.dispatched, ack.detail).toBe(true);
    const seq = Number(/inbound seq (\d+)/.exec(ack.detail ?? '')?.[1]);
    expect(Number.isSafeInteger(seq)).toBe(true);
    return seq;
  }

  function inboundRow(seq: number): { processing_status: string; conversation_key: string; chat_jid: string } {
    return db.raw.prepare(
      'SELECT processing_status, conversation_key, chat_jid FROM inbound_events WHERE seq = ?',
    ).get(seq) as { processing_status: string; conversation_key: string; chat_jid: string };
  }

  function inboundSeqByMessageId(messageId: string): number {
    const row = db.raw.prepare('SELECT seq FROM inbound_events WHERE message_id = ?').get(messageId) as
      | { seq: number }
      | undefined;
    if (row === undefined) throw new Error(`no inbound row for ${messageId}`);
    return row.seq;
  }

  function terminalRecords(seq: number): Array<{ conversation_key: string; inbound_disposition: string }> {
    return db.raw.prepare(
      'SELECT conversation_key, inbound_disposition FROM turn_terminal_records WHERE inbound_seq = ?',
    ).all(seq) as Array<{ conversation_key: string; inbound_disposition: string }>;
  }

  function replyOps(seq: number): Array<{ conversation_key: string; status: string }> {
    return db.raw.prepare(
      'SELECT conversation_key, status FROM outbound_ops WHERE source_inbound_seq = ? ORDER BY id',
    ).all(seq) as Array<{ conversation_key: string; status: string }>;
  }

  /** The mapping changes with no alias event. */
  function addMapping(): void {
    db.raw.prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)').run(LID_LOCAL, PHONE_JID);
  }

  function dropMapping(): void {
    db.raw.prepare('DELETE FROM lid_mappings WHERE lid = ?').run(LID_LOCAL);
  }

  function supervisorHealth(): { retainedRetries: number; degradedScopes: number } {
    return (live() as unknown as {
      runtimeTurnSupervisor: { health(): { retainedRetries: number; degradedScopes: number } };
    }).runtimeTurnSupervisor.health();
  }

  function laneQueue(mapKey: string): TurnQueue | undefined {
    return (live() as unknown as { perChatTurnQueues: Map<string, TurnQueue> }).perChatTurnQueues.get(mapKey);
  }

  function backdate(seq: number, interval = '-25 hours'): void {
    db.raw.prepare(`UPDATE inbound_events SET received_at = datetime('now', ?) WHERE seq = ?`).run(interval, seq);
  }

  function hasSession(mapKey: string): boolean {
    return (live() as unknown as { chatSessions: Map<string, unknown> }).chatSessions.has(mapKey);
  }

  function outboundQueueFor(mapKey: string): QueueDouble | undefined {
    return (live() as unknown as { chatQueues: Map<string, QueueDouble> }).chatQueues.get(mapKey);
  }

  function bufferAt(key: string): { texts: string[]; inboundSeqs: number[]; msg: { chatJid: string; messageId: string } } | undefined {
    return (live() as unknown as {
      imageCoalesce: { buffers: Map<string, { texts: string[]; inboundSeqs: number[]; msg: { chatJid: string; messageId: string } }> };
    }).imageCoalesce.buffers.get(key);
  }

  /** The flush the coalesce timer would run, forced so a test does not wait out the 3 s window. */
  async function flushImageCoalesce(mapKey: string): Promise<void> {
    await (live() as unknown as { flushImageCoalesce(key: string): Promise<void> }).flushImageCoalesce(mapKey);
  }

  /**
   * The turn finalized against the expected key with no reply, its inbound
   * completed, and nothing is retained.
   */
  async function expectFinalizedNoReply(seq: number, conversationKey: string): Promise<void> {
    await vi.waitFor(() => {
      expect(finalizeErrors.length > 0 || terminalRecords(seq).length > 0).toBe(true);
    }, { timeout: 4_000 });
    expect(finalizeErrors).toEqual([]);
    expect(terminalRecords(seq)).toEqual([
      { conversation_key: conversationKey, inbound_disposition: 'finalized_no_reply_policy' },
    ]);
    expect(replyOps(seq)).toEqual([]);
    await vi.waitFor(() => expect(inboundRow(seq).processing_status).toBe('complete'), { timeout: 4_000 });
    expect(finalizationAlertCalls()).toEqual([]);
    expect(supervisorHealth()).toMatchObject({ retainedRetries: 0, degradedScopes: 0 });
  }

  /** A retained turn would make shutdown reject; afterEach swallows that, so assert it here. */
  async function expectCleanShutdown(): Promise<void> {
    await expect(live().shutdown()).resolves.toBeUndefined();
    runtime = undefined;
  }

  /** Ingest one customer text, answer it, and return its journal sequence once it completes. */
  async function answerCustomer(
    ingest: (msg: IncomingMessage) => void,
    chatJid: string,
    messageId: string,
    content: string,
  ): Promise<number> {
    ingest(customerMsg(chatJid, messageId, { content }));
    (await waitForInFlightTurn((t) => t.includes(content))).emit({ type: 'result', text: 'On it.' });
    await drainIngest();
    const seq = inboundSeqByMessageId(messageId);
    await vi.waitFor(() => expect(inboundRow(seq).processing_status).toBe('complete'), { timeout: 4_000 });
    return seq;
  }

  /**
   * Image A buffered on the unmapped LID lane, then the alias event and the
   * mapping in src/main.ts:783-786 order. Returns A's seq.
   */
  async function migrateOpenLidImageBuffer(
    agent: AgentRuntime,
    ingest: (msg: IncomingMessage) => void,
  ): Promise<number> {
    dropMapping();
    ingest(customerMsg(LID_JID, 'wamid-img-a', { contentType: 'image', content: '[image]' }));
    await drainIngest();
    const seqA = inboundSeqByMessageId('wamid-img-a');
    await vi.waitFor(() => expect(bufferAt(LID_JID)).toMatchObject({ inboundSeqs: [seqA] }), COALESCE_WAIT);
    expect(inboundRow(seqA)).toMatchObject({ conversation_key: LID_LOCAL, chat_jid: LID_JID });
    expect(hasSession(LID_JID)).toBe(true);
    expect(hasSession(PHONE_JID)).toBe(false);
    expect(sessionDoubles.some((s) => s.turnInFlight)).toBe(false);

    agent.handleJidAliasChanged(LID_LOCAL, PHONE_JID);
    upsertLidMapping(db, LID_LOCAL, PHONE_JID);
    return seqA;
  }

  for (const sessionScope of ['per_chat', 'single'] as const) {
    it(`${sessionScope}: the delivered turn finalizes and completes its synthetic inbound`, async () => {
      // Precondition: the mapping is live, so the raw and canonical keys differ.
      expect(canonicalConversationKey(LID_JID, db)).toBe(PHONE_DIGITS);
      expect(toConversationKey(LID_JID)).not.toBe(PHONE_DIGITS);

      const agent = makeRuntime({ sessionScope });
      const ack = agent.dispatchAgentJob({
        beadId: 7,
        triggerId: 5,
        occurrenceId: 11,
        prompt: 'Summarize the overnight queue.',
        title: 'Overnight summary',
        reportChatJid: LID_JID,
      });
      expect(ack.dispatched, ack.detail).toBe(true);
      const seq = Number(/inbound seq (\d+)/.exec(ack.detail ?? '')?.[1]);
      expect(Number.isSafeInteger(seq)).toBe(true);

      const session = await waitForScheduledTurn();
      session.emit({ type: 'result', text: 'Overnight summary: nothing pending.' });

      await vi.waitFor(() => {
        expect(finalizeErrors.length > 0 || terminalRecords(seq).length > 0).toBe(true);
      }, { timeout: 4_000 });

      expect(finalizeErrors).toEqual([]);
      expect(terminalRecords(seq)).toEqual([
        { conversation_key: PHONE_DIGITS, inbound_disposition: 'finalized_replied' },
      ]);
      await vi.waitFor(() => expect(inboundRow(seq).processing_status).toBe('complete'), { timeout: 4_000 });
      expect(inboundRow(seq)).toMatchObject({ conversation_key: PHONE_DIGITS, chat_jid: LID_JID });
      const ops = replyOps(seq);
      expect(ops.length).toBeGreaterThan(0);
      expect(ops.every((op) => op.conversation_key === PHONE_DIGITS && op.status === 'echoed')).toBe(true);
      expect(finalizationAlertCalls()).toEqual([]);

      await expect(agent.shutdown()).resolves.toBeUndefined();
      runtime = undefined;
    });

    it(`${sessionScope}: a mapping written after the job is journaled does not change its turn's key`, async () => {
      dropMapping();
      const agent = makeRuntime({ sessionScope });
      const seq = dispatchJob(agent);
      // The identity read runs later, behind the turn chain (runtime.ts:4847-4848).
      addMapping();
      expect(inboundRow(seq).conversation_key).toBe(LID_LOCAL);

      suppressReply(await waitForScheduledTurn());

      await expectFinalizedNoReply(seq, LID_LOCAL);
      await expectCleanShutdown();
    });
  }

  it('per_chat: a mapping written between ingest\'s journal write and dispatch does not change the turn\'s key', async () => {
    dropMapping();
    const agent = makeRuntime({ sessionScope: 'per_chat' });
    const ingest = makeIngest(agent);
    // Ingest calls handleMessage (ingest.ts:564) only after its key read, the
    // journal write and the carried-key assignment, so the mapping lands after
    // all three and before the runtime's identity read.
    const original = agent.handleMessage.bind(agent);
    const spy = vi.spyOn(agent, 'handleMessage').mockImplementation((m) => {
      addMapping();
      return original(m);
    });
    ingest(customerMsg(LID_JID, 'wamid-c1', { content: 'hello' }));

    suppressReply(await waitForInFlightTurn((t) => t.includes('hello')));
    await drainIngest();
    const seq = inboundSeqByMessageId('wamid-c1');

    expect(spy.mock.calls[0]?.[0]).toMatchObject({ inboundSeq: seq, journaledConversationKey: LID_LOCAL });
    expect(inboundRow(seq).conversation_key).toBe(LID_LOCAL);
    await expectFinalizedNoReply(seq, LID_LOCAL);
    await expectCleanShutdown();
  });

  it('per_chat: a mapping written while an image is buffered does not change its turn\'s key', async () => {
    dropMapping();
    const agent = makeRuntime({ sessionScope: 'per_chat' });
    makeIngest(agent)(customerMsg(LID_JID, 'wamid-img1', { contentType: 'image', content: '[image]' }));
    await drainIngest();
    const seq = inboundSeqByMessageId('wamid-img1');
    await vi.waitFor(() => expect(bufferAt(LID_JID)).toMatchObject({ inboundSeqs: [seq] }), COALESCE_WAIT);

    // Raw SQL: no alias event fires, so the buffer stays on the LID lane.
    addMapping();
    await flushImageCoalesce(LID_JID);
    suppressReply(await waitForInFlightTurn((t) => t.includes('[image]')));

    await expectFinalizedNoReply(seq, LID_LOCAL);
    await expectCleanShutdown();
  });

  it('per_chat: an alias migration of an open LID image buffer keeps its journal identity', async () => {
    const agent = makeRuntime({ sessionScope: 'per_chat' });
    const ingest = makeIngest(agent);
    const seqA = await migrateOpenLidImageBuffer(agent, ingest);

    expect(bufferAt(LID_JID)).toBeUndefined();
    expect(bufferAt(PHONE_JID)).toMatchObject({
      inboundSeqs: [seqA],
      msg: { chatJid: LID_JID },
      journaledMsg: { messageId: 'wamid-img-a', chatJid: LID_JID },
    });
    expect(outboundQueueFor(PHONE_JID)?.targetChatJid).toBe(LID_JID);
    expect(outboundQueueFor(PHONE_JID)?.updateDeliveryJid).toHaveBeenCalledWith(PHONE_JID);

    // The flush the migrated timer would run (runtime.ts:3840-3842).
    await flushImageCoalesce(PHONE_JID);
    // No answer on purpose: this lane's queue keeps the LID key and sends to the
    // phone while the image turn's identity JID is the LID, so an answer would
    // fail the delivery proof with or without the journal identity.
    suppressReply(await waitForInFlightTurn((t) => t.includes('[image]')));
    await expectFinalizedNoReply(seqA, LID_LOCAL);

    // The customer's next turn on the phone lane is admitted.
    ingest(customerMsg(PHONE_JID, 'wamid-c2', { content: 'hello' }));
    suppressReply(await waitForInFlightTurn((t) => t.includes('hello')));
    await drainIngest();
    const seqC = inboundSeqByMessageId('wamid-c2');
    expect(inboundRow(seqC)).toMatchObject({ conversation_key: PHONE_DIGITS, chat_jid: PHONE_JID });
    await expectFinalizedNoReply(seqC, PHONE_DIGITS);
    expect(admissionRejectedCalls()).toEqual([]);

    await expectCleanShutdown();
  });

  it('per_chat: a batch built through migration takes its identity from its last journaled image', async () => {
    const agent = makeRuntime({ sessionScope: 'per_chat' });
    const ingest = makeIngest(agent);
    const seqA = await migrateOpenLidImageBuffer(agent, ingest);

    ingest(customerMsg(PHONE_JID, 'wamid-img-b', { contentType: 'image', content: '[image]' }));
    await drainIngest();
    const seqB = inboundSeqByMessageId('wamid-img-b');
    await vi.waitFor(() => expect(bufferAt(PHONE_JID)?.inboundSeqs).toHaveLength(2), COALESCE_WAIT);
    expect(inboundRow(seqB)).toMatchObject({ conversation_key: PHONE_DIGITS, chat_jid: PHONE_JID });

    await flushImageCoalesce(PHONE_JID);
    const session = await waitForInFlightTurn((t) => t.includes('[2 images received]'));
    expect(laneQueue(PHONE_JID)?.activeTurn).toMatchObject({
      sourceMessageId: 'wamid-img-b',
      inboundSeq: seqB,
      conversationKey: PHONE_DIGITS,
      chatJid: PHONE_JID,
    });
    // No answer on purpose: the lane's queue key is the LID, so an answered seqB
    // would fail the delivery proof with or without this change.
    suppressReply(session);
    await expectFinalizedNoReply(seqB, PHONE_DIGITS);
    // A was coalesced into B's turn (runtime.ts:2376-2378).
    expect(terminalRecords(seqA)).toEqual([]);
    expect(['pending', 'processing']).not.toContain(inboundRow(seqA).processing_status);

    await expectCleanShutdown();
  });

  it('per_chat: an unjournaled replay image after a migrated journaled image keeps the journaled identity', async () => {
    dropMapping();
    const agent = makeRuntime({ sessionScope: 'per_chat' });
    makeIngest(agent)(customerMsg(LID_JID, 'wamid-img-a', { contentType: 'image', content: '[image]' }));
    await drainIngest();
    const seqA = inboundSeqByMessageId('wamid-img-a');
    // Ordering precondition. The 3 s image-coalesce timer (IMAGE_COALESCE_MS) is real and not
    // controlled here. B is appended after the A-only buffer only because nothing between that
    // observation and B's append yields to the timer phase: prepareContentForAgent is the immediate
    // double above, and this fresh runtime, not in sandbox per-chat mode, sets up the per-chat session
    // synchronously. A harness change that adds a real wait there can let the timer flush A alone;
    // the toHaveLength(2) wait after B's handleMessage then times out instead of passing.
    await vi.waitFor(
      () => expect(bufferAt(LID_JID)).toMatchObject({ texts: ['[image]'], inboundSeqs: [seqA] }),
      COALESCE_WAIT,
    );
    agent.handleJidAliasChanged(LID_LOCAL, PHONE_JID);
    upsertLidMapping(db, LID_LOCAL, PHONE_JID);

    void agent.handleMessage(replayMsg(PHONE_JID, 'wamid-img-b', { contentType: 'image', content: '[image]' }));
    await vi.waitFor(() => expect(bufferAt(PHONE_JID)?.texts).toHaveLength(2), COALESCE_WAIT);
    expect(bufferAt(PHONE_JID)).toMatchObject({ inboundSeqs: [seqA], msg: { messageId: 'wamid-img-b' } });

    await flushImageCoalesce(PHONE_JID);
    const session = await waitForInFlightTurn((t) => t.includes('[2 images received]'));
    expect(laneQueue(PHONE_JID)?.activeTurn).toMatchObject({
      sourceMessageId: 'wamid-img-a',
      inboundSeq: seqA,
      conversationKey: LID_LOCAL,
      chatJid: LID_JID,
    });
    suppressReply(session);
    await expectFinalizedNoReply(seqA, LID_LOCAL);

    await expectCleanShutdown();
  });

  it('per_chat: a recovery transfer of a batch ending in an unjournaled replay names the journaled source', async () => {
    // Mapping present and no alias event: key and chat JID agree, so only the
    // source message id can differ. The lane's queue is phone-keyed.
    const agent = makeRuntime({ sessionScope: 'per_chat' });
    makeIngest(agent)(customerMsg(PHONE_JID, 'wamid-img-a', { contentType: 'image', content: '[image]' }));
    await drainIngest();
    const seqA = inboundSeqByMessageId('wamid-img-a');
    // Ordering precondition. The 3 s image-coalesce timer (IMAGE_COALESCE_MS) is real and not
    // controlled here. B is appended after the A-only buffer only because nothing between that
    // observation and B's append yields to the timer phase: prepareContentForAgent is the immediate
    // double above, and this fresh runtime, not in sandbox per-chat mode, sets up the per-chat session
    // synchronously. A harness change that adds a real wait there can let the timer flush A alone;
    // the toHaveLength(2) wait after B's handleMessage then times out instead of passing.
    await vi.waitFor(
      () => expect(bufferAt(PHONE_JID)).toMatchObject({ texts: ['[image]'], inboundSeqs: [seqA] }),
      COALESCE_WAIT,
    );
    void agent.handleMessage(replayMsg(PHONE_JID, 'wamid-img-b', { contentType: 'image', content: '[image]' }));
    await vi.waitFor(() => expect(bufferAt(PHONE_JID)?.texts).toHaveLength(2), COALESCE_WAIT);
    expect(bufferAt(PHONE_JID)).toMatchObject({ inboundSeqs: [seqA], msg: { messageId: 'wamid-img-b' } });

    harnessRef.current!.answerOpStatus = 'pending';
    await flushImageCoalesce(PHONE_JID);
    (await waitForInFlightTurn((t) => t.includes('[2 images received]')))
      .emit({ type: 'result', text: 'Two photos received.' });

    await vi.waitFor(() => {
      expect(finalizeErrors.length > 0 || terminalRecords(seqA).length > 0).toBe(true);
    }, { timeout: 4_000 });
    expect({
      errors: finalizeErrors,
      sourceMessageId: finalizeCalls.at(-1)?.recoveryJob?.sourceMessageId,
    }).toEqual({ errors: [], sourceMessageId: 'wamid-img-a' });
    expect(terminalRecords(seqA)).toEqual([
      { conversation_key: PHONE_DIGITS, inbound_disposition: 'transferred_to_recovery_owner' },
    ]);

    await expectCleanShutdown();
  });

  it('per_chat: a job caught by the mapping race does not block the customer\'s turns', async () => {
    dropMapping();
    const agent = makeRuntime({ sessionScope: 'per_chat' });
    const jobSeq = dispatchJob(agent);
    addMapping();
    suppressReply(await waitForScheduledTurn());
    await expectFinalizedNoReply(jobSeq, LID_LOCAL);

    // The customer lane is created with the mapping present, so its queue is
    // phone-keyed from the start.
    const ingest = makeIngest(agent);
    const viaLid = await answerCustomer(ingest, LID_JID, 'wamid-race-lid', 'question via lid');
    const viaPhone = await answerCustomer(ingest, PHONE_JID, 'wamid-race-phone', 'question via phone');
    expect(replyOps(viaLid)).toEqual([{ conversation_key: PHONE_DIGITS, status: 'echoed' }]);
    expect(replyOps(viaPhone)).toEqual([{ conversation_key: PHONE_DIGITS, status: 'echoed' }]);
    expect(supervisorHealth()).toMatchObject({ retainedRetries: 0, degradedScopes: 0 });
    expect(admissionRejectedCalls()).toEqual([]);

    await expectCleanShutdown();
  });

  it('per_chat: with the mapping present before dispatch, the job and both customers are answered', async () => {
    const agent = makeRuntime({ sessionScope: 'per_chat' });
    const jobSeq = dispatchJob(agent);
    (await waitForScheduledTurn()).emit({ type: 'result', text: 'Overnight summary: nothing pending.' });
    await vi.waitFor(() => {
      expect(finalizeErrors.length > 0 || terminalRecords(jobSeq).length > 0).toBe(true);
    }, { timeout: 4_000 });
    expect(finalizeErrors).toEqual([]);
    expect(terminalRecords(jobSeq)).toEqual([
      { conversation_key: PHONE_DIGITS, inbound_disposition: 'finalized_replied' },
    ]);

    const ingest = makeIngest(agent);
    const viaLid = await answerCustomer(ingest, LID_JID, 'wamid-guard-lid', 'question via lid');
    const viaPhone = await answerCustomer(ingest, PHONE_JID, 'wamid-guard-phone', 'question via phone');
    expect(replyOps(viaLid)).toEqual([{ conversation_key: PHONE_DIGITS, status: 'echoed' }]);
    expect(replyOps(viaPhone)).toEqual([{ conversation_key: PHONE_DIGITS, status: 'echoed' }]);
    expect(supervisorHealth()).toMatchObject({ retainedRetries: 0, degradedScopes: 0 });

    await expectCleanShutdown();
  });

  describe('per_chat: a wedged lane is matched to the reclaimed row by sequence', () => {
    const lane = `${PHONE_JID}::scheduled-agent-job`;

    /** The job, dispatched to the mapped LID chat, held in flight on its own lane. */
    async function pinInFlightJob(agent: AgentRuntime): Promise<{ seq: number; session: SessionDouble }> {
      const seq = dispatchJob(agent);
      const session = await waitForScheduledTurn();
      await vi.waitFor(() => expect(laneQueue(lane)?.activeTurn?.inboundSeq).toBe(seq), { timeout: 4_000 });
      return { seq, session };
    }

    async function expectReleased(session: SessionDouble): Promise<void> {
      await vi.waitFor(() => expect(laneQueue(lane)?.activeTurn ?? null).toBeNull(), { timeout: 4_000 });
      expect(session.reapWedgedProviderChild).toHaveBeenCalledTimes(1);
      expect(alertCalls(WEDGE_RELEASE_ALERT)).toHaveLength(1);
    }

    it('a mapped @lid lane is released when the sweep reclaims its row', async () => {
      const agent = makeRuntime({ sessionScope: 'per_chat' });
      const { seq, session } = await pinInFlightJob(agent);

      backdate(seq);
      expect(engine.sweepStuckInbound()).toMatchObject({ failedStale: 1 });

      await expectReleased(session);
      await expectCleanShutdown();
    });

    it('a row with another sequence is skipped, and the real sequence is released', async () => {
      const agent = makeRuntime({ sessionScope: 'per_chat' });
      const { seq, session } = await pinInFlightJob(agent);
      const active = laneQueue(lane)?.activeTurn;
      if (!active) throw new Error('the job lane has no active turn');
      const rejectCompletion = vi.spyOn(
        (agent as unknown as {
          runtimeTurnCoordinator: { rejectRuntimeTurnCompletion: (...args: never[]) => boolean };
        }).runtimeTurnCoordinator,
        'rejectRuntimeTurnCompletion',
      );

      // Same message id and key as the lane's turn, but another sequence.
      (agent as unknown as {
        releaseWedgedReclaimedLanes(rows: Array<{ seq: number; sourceMessageId: string; conversationKey: string }>): void;
      }).releaseWedgedReclaimedLanes([
        { seq: seq + 1, sourceMessageId: active.sourceMessageId, conversationKey: active.conversationKey },
      ]);
      expect(laneQueue(lane)?.activeTurn?.inboundSeq).toBe(seq);
      expect(session.reapWedgedProviderChild).not.toHaveBeenCalled();
      expect(alertCalls(WEDGE_RELEASE_ALERT)).toEqual([]);
      expect(rejectCompletion).not.toHaveBeenCalled();

      // The sweep, the listener's production caller, reclaims the real row.
      backdate(seq);
      expect(engine.sweepStuckInbound()).toMatchObject({ failedStale: 1 });
      await expectReleased(session);
      await expectCleanShutdown();
    });

    it('a mapping dropped before the sweep does not keep the lane wedged', async () => {
      const agent = makeRuntime({ sessionScope: 'per_chat' });
      const { seq, session } = await pinInFlightJob(agent);

      dropMapping();
      backdate(seq);
      expect(engine.sweepStuckInbound()).toMatchObject({ failedStale: 1 });

      await expectReleased(session);
      await expectCleanShutdown();
    });
  });
});
