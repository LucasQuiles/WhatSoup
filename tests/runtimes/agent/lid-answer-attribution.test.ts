// A turn's outbound operations carry the turn's own attribution.
//
// The delivery proofs compare a turn's answer op with the inbound row the turn
// was journaled under: its conversation key, chat JID and sequence. A queue's
// own key is fixed when the queue is created, and its delivery JID follows the
// latest retarget. So an alias migration, a queue created after a LID mapping,
// a queue rebuilt for a provider result or created by a provider fallback, and
// a single-scope queue serving another chat can each stamp an answer with
// values the turn does not carry. These cases answer turns on the REAL outbound
// queue and check the stamped op, the send target and the turn's outcome.
//
// Harness: REAL AgentRuntime + REAL OutboundQueue + REAL SQLite durability +
// REAL ingest; only the provider boundary and the transport are doubled, as in
// scheduled-lid-report-chat-finalize.test.ts. The transport's echo arrives as
// soon as a send is marked submitted, unless a case turns it off.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Messenger, IncomingMessage } from '../../../src/core/types.ts';
import type { ClientOutputPolicyRegistry } from '../../../src/core/client-output-policy-config.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import type { RuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';

// ─── Hoisted per-construction provider-boundary doubles ─────────────────────

const { sessionDoubles, resetDoubles, makeSessionDouble } = vi.hoisted(() => {
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
      // Like the real SessionManager.shutdown, which ends with completeProviderTurn:
      // an in-flight sendTurn settles, so no case can stall on a shut-down double.
      shutdown: vi.fn(async () => {
        active = false;
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve?.();
      }),
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

  const sessionDoubles: Array<ReturnType<typeof makeSessionDouble>> = [];

  function resetDoubles(): void {
    sessionDoubles.length = 0;
  }

  return { sessionDoubles, resetDoubles, makeSessionDouble };
});

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set<string>(['15550001']),
    controlPeers: new Map<string, string>(),
    internalPeerJids: new Set<string>(),
    clientOutputPolicies: undefined as ClientOutputPolicyRegistry | undefined,
    // The real queue reads the echo guard before every send; disabled, it never drops one.
    echoGuard: { enabled: false },
    toolUpdateMode: 'full' as const,
    toolUpdateRedirectJid: null as string | null,
    textAggregateDelayMs: 2_000,
    stateRoot: `/tmp/whatsoup-test-state-lid-answer-${process.pid}`,
    restartLoopGuard: { enabled: true, maxRestarts: 3, windowMs: 300_000 },
    startupNotifications: false,
    proactiveResumeOnStartup: false,
    mediaDir: `/tmp/whatsoup-test-media-lid-answer-${process.pid}`,
    pineconeAllowedIndexes: [] as string[],
    voiceReply: 'never' as 'always' | 'when_received' | 'never',
    elevenlabs: { defaultVoiceId: 'v', defaultModel: 'm', stability: 0.5, similarityBoost: 0.75 },
    memory: { adminJid: 'admin@s.whatsapp.net' },
  },
}));

// The voice temp path is both writeTempFile's result and the fs stub's guard.
const { mockSynthesizeSpeech, mockWriteTempFile, VOICE_TEMP_PATH } = vi.hoisted(() => {
  const VOICE_TEMP_PATH = '/tmp/voice-reply.mp3';
  return { mockSynthesizeSpeech: vi.fn(), mockWriteTempFile: vi.fn(() => VOICE_TEMP_PATH), VOICE_TEMP_PATH };
});

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

vi.mock('../../../src/config.ts', () => ({ config: mockConfig }));

vi.mock('../../../src/runtimes/chat/providers/elevenlabs.ts', () => ({
  synthesizeSpeech: mockSynthesizeSpeech,
}));

vi.mock('../../../src/core/media-download.ts', () => ({
  writeTempFile: mockWriteTempFile,
  downloadMedia: vi.fn(),
}));

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
    // Only the synthesized voice file is faked; every other read reaches the real file system.
    readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) =>
      args[0] === VOICE_TEMP_PATH ? Buffer.from('fake-audio-data') : actual.readFileSync(...args)),
  };
});

// ─── Imports under test (after mocks) ───────────────────────────────────────

import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import { createIngestHandler } from '../../../src/core/ingest.ts';
import { upsertLidMapping } from '../../../src/core/lid-resolver.ts';
import { parseClientOutputPolicies } from '../../../src/core/client-output-policy-config.ts';
import { AgentRuntime, type AgentRuntimeOptions } from '../../../src/runtimes/agent/runtime.ts';
import { emitAlert, emitAlertChecked } from '../../../src/lib/emit-alert.ts';
import { installFakePerChatMcpSocketManager } from './helpers/fake-per-chat-mcp-socket-manager.ts';
import { drainIngest } from '../../core/_helpers/ingest-drain.ts';

// ─── Shared fixtures (synthetic identities only) ────────────────────────────

const LID_LOCAL = '900000000000042';
const LID_JID = `${LID_LOCAL}@lid`;
const PHONE_DIGITS = '15550004242';
const PHONE_JID = `${PHONE_DIGITS}@s.whatsapp.net`;
// Two unmapped chats for the single- and shared-scope cases.
const A_KEY = '15550004301';
const A_JID = `${A_KEY}@s.whatsapp.net`;
const B_KEY = '15550004302';
const B_JID = `${B_KEY}@s.whatsapp.net`;
const SCHEDULED_PROMPT_MARK = '[isolated scheduled background turn]';
const FINALIZATION_ALERT = 'agent_turn_finalization_failed';
const GLOBAL_TOOL_SCOPE = '__global__';
const BLOCKED_TERM = 'zebracorn';
const COALESCE_WAIT = { timeout: 4_000, interval: 10 };
// The real queue paces sends 500 ms apart.
const SEND_WAIT = { timeout: 8_000, interval: 10 };

// Copied from outbound-queue-client-output-policy.test.ts.
function registryFor(policy: Record<string, unknown>): ClientOutputPolicyRegistry {
  const parsed = parseClientOutputPolicies([policy]);
  if (!parsed.ok) throw new Error(`fixture policy invalid: ${parsed.error.field} ${parsed.error.reason}`);
  return parsed.registry;
}

const STRICT_POLICY = {
  conversationKey: B_KEY,
  maxCodePoints: 4000,
  maxQuestionMarks: 1,
  blockedTerms: [{ value: BLOCKED_TERM, match: 'whole_word', caseSensitive: false }],
  rejectInternalArtifacts: true,
  rejectWhatsAppJids: true,
};

/** Ingest's own transport; the runtime sends on the recording transport. */
function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

type MediaSend = [string, { type: string; ptt?: boolean }];

/** The runtime's transport: records each send and returns a distinct id for its echo. */
function makeRecordingTransport(): { messenger: Messenger; texts: Array<[string, string]>; media: MediaSend[] } {
  const texts: Array<[string, string]> = [];
  const media: MediaSend[] = [];
  const messenger = {
    sendMessage: vi.fn(async (jid: string, text: string) => {
      texts.push([jid, text]);
      return { waMessageId: `wa-${texts.length}` };
    }),
    sendMedia: vi.fn(async (jid: string, content: { type: string; ptt?: boolean }) => {
      media.push([jid, content]);
      return { waMessageId: null };
    }),
  } as unknown as Messenger;
  return { messenger, texts, media };
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
 * A turn that ends with no answer op. '.' is suppressed as NOOP text on a
 * customer lane, so the outcome is suppressed_by_policy.
 */
function suppressReply(session: SessionDouble): void {
  session.emit({ type: 'assistant_text', text: '.' });
  session.emit({ type: 'result', text: null });
}

function finalizationAlertCalls(): unknown[][] {
  return [
    ...vi.mocked(emitAlert).mock.calls,
    ...vi.mocked(emitAlertChecked).mock.calls,
  ].filter((call) => (call as unknown[]).includes(FINALIZATION_ALERT)) as unknown[][];
}

/** The failure stage and answer evidence of each finalization alert, in order. */
function alertFields(): Array<{ failure_stage: string | undefined; answer_evidence: string | undefined }> {
  return finalizationAlertCalls().map((call) => {
    const evidence = String(call[3] ?? '');
    const field = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(evidence)?.[1];
    return { failure_stage: field('failure_stage'), answer_evidence: field('answer_evidence') };
  });
}

type Settled = { ok: true; turnId: string | undefined } | { ok: false; message: string };

/** A resolution becomes { ok, turnId } and a rejection { ok: false, message }, so either can be compared. */
async function settle(work: Promise<unknown>): Promise<Settled> {
  try {
    const value = await work;
    return { ok: true, turnId: (value as { turnId?: string } | undefined)?.turnId };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** The runtime's private members these cases reach, through one cast. */
type RuntimeInternals = {
  chatQueues: Map<string, IOutboundQueue>;
  outboundQueues: Map<string, IOutboundQueue>;
  queue: IOutboundQueue | null;
  deleteOwnedPerChatSession(mapKey: string, expected: SessionDouble): boolean;
  discardPerChatSessionForFallback(mapKey: string, expected: SessionDouble): boolean;
  // Wider than the base runtime's helpers, which ignore the trailing context.
  recreatePerChatSessionForFallback(
    mapKey: string,
    chatJid: string,
    actorJid?: string,
    routeOverride?: undefined,
    runtimeContext?: RuntimeTurnContext,
  ): void;
  recreateSingletonSessionForFallback(
    chatJid: string,
    actorJid?: string,
    routeOverride?: undefined,
    runtimeContext?: RuntimeTurnContext,
  ): void;
  pendingSystemResults: {
    mark(entry: { scopeKey: string; purpose: string; owner: unknown; routeChatJid: string }): void;
  };
  captureSystemTurnOwner(session: SessionDouble, scopeKey: string): unknown;
  runtimeTurnCoordinator: {
    runtimeTurnContext(mapKey?: string): RuntimeTurnContext | null;
    replayTurnOnFallback(args: {
      chatJid: string;
      mapKey?: string;
      replayText: string;
      oldSession: null;
      runtimeContext: RuntimeTurnContext;
    }): Promise<void>;
  };
};

type OpRow = { conversation_key: string; chat_jid: string; source_inbound_seq: number | null; status: string };
const OP_COLUMNS = 'conversation_key, chat_jid, source_inbound_seq, status';

type SendMark = { texts: number; media: number };

describe('a turn\'s outbound operations carry the turn\'s attribution', () => {
  let db: Database;
  let engine: DurabilityEngine;
  let runtime: AgentRuntime | undefined;
  let transport: ReturnType<typeof makeRecordingTransport>;
  let finalizeErrors: string[];
  let finalizeCalls: Array<Parameters<DurabilityEngine['finalizeTurnTerminal']>[0]>;
  /** The transport's echo of each submitted send. Off, an answer op stays submitted. */
  let echoOnSubmit: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDoubles();
    echoOnSubmit = true;
    transport = makeRecordingTransport();
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
    // The transport's echo arriving at once. It doubles nothing on the attribution path.
    const markSubmitted = engine.markSubmitted.bind(engine);
    vi.spyOn(engine, 'markSubmitted').mockImplementation((id, waMessageId, logicalAttemptCount) => {
      markSubmitted(id, waMessageId, logicalAttemptCount);
      if (echoOnSubmit && waMessageId !== null) engine.matchEcho(waMessageId);
    });
  });

  afterEach(async () => {
    mockConfig.internalPeerJids = new Set<string>();
    mockConfig.clientOutputPolicies = undefined;
    mockConfig.voiceReply = 'never';
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
    const created = new AgentRuntime(db, transport.messenger, 'test', options);
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

  function internals(agent: AgentRuntime = live()): RuntimeInternals {
    return agent as unknown as RuntimeInternals;
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

  /** The ops linked to the turn's inbound row, in creation order. */
  function answerOps(seq: number): OpRow[] {
    return db.raw.prepare(
      `SELECT ${OP_COLUMNS} FROM outbound_ops WHERE source_inbound_seq = ? ORDER BY id`,
    ).all(seq) as OpRow[];
  }

  /** The newest n ops, oldest first; a rebuilt queue's op can carry no sequence. */
  function lastOps(n: number): OpRow[] {
    return (db.raw.prepare(
      `SELECT ${OP_COLUMNS} FROM outbound_ops ORDER BY id DESC LIMIT ?`,
    ).all(n) as OpRow[]).reverse();
  }

  /** The ops whose payload text is exactly `text`, whatever key and JID they carry. */
  function opsByText(text: string): OpRow[] {
    return db.raw.prepare(
      `SELECT ${OP_COLUMNS} FROM outbound_ops WHERE json_extract(payload, '$.text') = ? ORDER BY id`,
    ).all(text) as OpRow[];
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

  function health(): { retained: number; degraded: number } {
    const snapshot = supervisorHealth();
    return { retained: snapshot.retainedRetries, degraded: snapshot.degradedScopes };
  }

  function hasSession(mapKey: string): boolean {
    return (live() as unknown as { chatSessions: Map<string, unknown> }).chatSessions.has(mapKey);
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

  function markSends(): SendMark {
    return { texts: transport.texts.length, media: transport.media.length };
  }

  /** The runtime transport's text sends after `mark`, as [jid, text], in order. */
  function sendsSince(mark: SendMark): Array<[string, string]> {
    return transport.texts.slice(mark.texts);
  }

  /** The runtime transport's media sends after `mark`, as [jid, media], in order. */
  function mediaSince(mark: SendMark): MediaSend[] {
    return transport.media.slice(mark.media);
  }

  /**
   * The observation point for an answered turn. A delivery-proof failure happens
   * before finalizeTurnTerminal, so the wait ends on a terminal record or a
   * retained turn, whichever comes first.
   */
  async function waitForOutcome(seq: number): Promise<void> {
    await vi.waitFor(() => {
      expect(terminalRecords(seq).length > 0 || supervisorHealth().retainedRetries > 0).toBe(true);
    }, SEND_WAIT);
  }

  /** Waits in every state until an op with `text` is echoed and a send of it went to any JID. */
  async function waitForEchoedSend(text: string, mark: SendMark): Promise<void> {
    await vi.waitFor(() => {
      expect(
        opsByText(text).some((op) => op.status === 'echoed')
          && sendsSince(mark).some(([, sent]) => sent === text),
      ).toBe(true);
    }, SEND_WAIT);
  }

  type AnswerExpectation = { key: string; jid: string; text: string; disposition?: string; status?: string };

  function answeredState(seq: number, mark: SendMark) {
    return {
      terminal: terminalRecords(seq),
      health: health(),
      firstAnswerOp: answerOps(seq)[0],
      alerts: alertFields(),
      sends: sendsSince(mark),
    };
  }

  function answeredExpectation(seq: number, expected: AnswerExpectation) {
    return {
      terminal: [{ conversation_key: expected.key, inbound_disposition: expected.disposition ?? 'finalized_replied' }],
      health: { retained: 0, degraded: 0 },
      firstAnswerOp: {
        conversation_key: expected.key,
        chat_jid: expected.jid,
        source_inbound_seq: seq,
        status: expected.status ?? 'echoed',
      },
      alerts: [],
      sends: [[expected.jid, expected.text]],
    };
  }

  /**
   * The answered turn in one combined assertion: its terminal record, the
   * supervisor, its first answer op, the finalization alerts and the sends since
   * `mark`. A failure prints every field, so the mismatched one shows the cause.
   */
  async function expectAnswered(seq: number, expected: AnswerExpectation, mark: SendMark): Promise<void> {
    await waitForOutcome(seq);
    expect(answeredState(seq, mark)).toEqual(answeredExpectation(seq, expected));
  }

  /** A retained turn would make shutdown reject; afterEach swallows that, so assert it here. */
  async function expectCleanShutdown(): Promise<void> {
    await expect(live().shutdown()).resolves.toBeUndefined();
    runtime = undefined;
  }

  /**
   * Settles each double's open provider dispatch with its own completeProviderTurn.
   * A replaced double's dispatch cannot be settled by a result event, which the
   * runtime routes to the current session. In single scope shutdown joins that
   * intake before it shuts sessions down, so an open dispatch makes it reject.
   */
  function settleOpenProviderTurns(): void {
    for (const double of sessionDoubles) if (double.turnInFlight) double.completeProviderTurn();
  }

  /** Ingest one customer text, answer it, and return its journal sequence once it completes. */
  async function answerCustomer(
    ingest: (msg: IncomingMessage) => void,
    chatJid: string,
    messageId: string,
    content: string,
    answer: string,
  ): Promise<number> {
    ingest(customerMsg(chatJid, messageId, { content }));
    (await waitForInFlightTurn((t) => t.includes(content))).emit({ type: 'result', text: answer });
    await drainIngest();
    const seq = inboundSeqByMessageId(messageId);
    await vi.waitFor(() => expect(inboundRow(seq).processing_status).toBe('complete'), SEND_WAIT);
    return seq;
  }

  /** Ingest one customer text and return the session holding its provider turn open, with its sequence. */
  async function openCustomerTurn(
    agent: AgentRuntime,
    chatJid: string,
    messageId: string,
    content: string,
  ): Promise<{ session: SessionDouble; seq: number }> {
    makeIngest(agent)(customerMsg(chatJid, messageId, { content }));
    const session = await waitForInFlightTurn((t) => t.includes(content));
    await drainIngest();
    return { session, seq: inboundSeqByMessageId(messageId) };
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

  describe('LID chats across a mapping or an alias migration', () => {
    it('per_chat: a phone turn on a migrated LID lane is answered under the phone key', async () => {
      dropMapping();
      const agent = makeRuntime({ sessionScope: 'per_chat' });
      const ingest = makeIngest(agent);
      ingest(customerMsg(LID_JID, 'wamid-q1', { content: 'hello' }));
      suppressReply(await waitForInFlightTurn((t) => t.includes('hello')));
      await drainIngest();
      const seq1 = inboundSeqByMessageId('wamid-q1');
      await vi.waitFor(() => expect(inboundRow(seq1).processing_status).toBe('complete'), SEND_WAIT);
      // The migration's preconditions: a LID lane, no phone lane, and no turn in flight.
      expect({
        lid: hasSession(LID_JID),
        phone: hasSession(PHONE_JID),
        inFlight: sessionDoubles.some((s) => s.turnInFlight),
      }).toEqual({ lid: true, phone: false, inFlight: false });
      agent.handleJidAliasChanged(LID_LOCAL, PHONE_JID);
      upsertLidMapping(db, LID_LOCAL, PHONE_JID);

      const mark = markSends();
      ingest(customerMsg(PHONE_JID, 'wamid-q2', { content: 'again' }));
      (await waitForInFlightTurn((t) => t.includes('again'))).emit({ type: 'result', text: 'reply two' });
      await drainIngest();
      const seq2 = inboundSeqByMessageId('wamid-q2');

      await expectAnswered(seq2, { key: PHONE_DIGITS, jid: PHONE_JID, text: 'reply two' }, mark);
      await expectCleanShutdown();
      expect(sendsSince(mark)).toEqual([[PHONE_JID, 'reply two']]);
    });

    it('per_chat: a LID turn on a lane created after the mapping is answered under the LID key', async () => {
      dropMapping();
      const agent = makeRuntime({ sessionScope: 'per_chat' });
      const ingest = makeIngest(agent);
      // The mapping lands after ingest's journal write and before the runtime builds the lane.
      const original = agent.handleMessage.bind(agent);
      vi.spyOn(agent, 'handleMessage').mockImplementation((m) => {
        addMapping();
        return original(m);
      });
      const mark = markSends();
      ingest(customerMsg(LID_JID, 'wamid-r1', { content: 'hello' }));
      (await waitForInFlightTurn((t) => t.includes('hello'))).emit({ type: 'result', text: 'reply one' });
      await drainIngest();
      const seq = inboundSeqByMessageId('wamid-r1');

      await expectAnswered(seq, { key: LID_LOCAL, jid: LID_JID, text: 'reply one' }, mark);
      await expectCleanShutdown();
      expect(sendsSince(mark)).toEqual([[LID_JID, 'reply one']]);
    });

    it('per_chat: a migrated image turn is answered under its journaled LID identity', async () => {
      const agent = makeRuntime({ sessionScope: 'per_chat' });
      const seqA = await migrateOpenLidImageBuffer(agent, makeIngest(agent));

      const mark = markSends();
      await flushImageCoalesce(PHONE_JID);
      (await waitForInFlightTurn((t) => t.includes('[image]'))).emit({ type: 'result', text: 'Photo received.' });

      await expectAnswered(seqA, { key: LID_LOCAL, jid: LID_JID, text: 'Photo received.' }, mark);
      await expectCleanShutdown();
      expect(sendsSince(mark)).toEqual([[LID_JID, 'Photo received.']]);
    });

    it('per_chat: a turn repaired onto a new phone-keyed queue is answered under its LID key', async () => {
      dropMapping();
      const agent = makeRuntime({ sessionScope: 'per_chat' });
      const ingest = makeIngest(agent);
      ingest(customerMsg(LID_JID, 'wamid-n1', { content: 'hello' }));
      const first = await waitForInFlightTurn((t) => t.includes('hello'));
      // Turn 2 waits in the lane's FIFO under map key LID_JID, journaled under the LID key.
      ingest(customerMsg(LID_JID, 'wamid-n2', { content: 'again' }));
      await drainIngest();
      const seq1 = inboundSeqByMessageId('wamid-n1');
      const seq2 = inboundSeqByMessageId('wamid-n2');
      // Raw SQL: no alias event, so no rekey.
      addMapping();
      const q1 = internals().chatQueues.get(LID_JID);

      // In one synchronous block: turn 1's result is accepted while its session is
      // current, and the session is retired before the FIFO can dispatch turn 2.
      first.emit({ type: 'result', text: 'reply one' });
      internals().deleteOwnedPerChatSession(LID_JID, first);

      // Turn 2's dispatch finds no session and repairs the lane with a new session
      // and a new queue, created after the mapping and so phone-keyed.
      const second = await waitForInFlightTurn((t) => t.includes('again'));
      await waitForOutcome(seq1);
      const mark = markSends();
      second.emit({ type: 'result', text: 'reply two' });

      expect({
        turn1: terminalRecords(seq1),
        repair: {
          sessions: sessionDoubles.length,
          turn2Sent: sessionDoubles[1]?.turnsSent.length,
          queueReplaced: internals().chatQueues.get(LID_JID) !== q1,
        },
      }).toEqual({
        turn1: [{ conversation_key: LID_LOCAL, inbound_disposition: 'finalized_replied' }],
        repair: { sessions: 2, turn2Sent: 1, queueReplaced: true },
      });
      await expectAnswered(seq2, { key: LID_LOCAL, jid: LID_JID, text: 'reply two' }, mark);
      await expectCleanShutdown();
      expect(sendsSince(mark)).toEqual([[LID_JID, 'reply two']]);
    });

    it('per_chat: a migrated batch ending in an unjournaled replay transfers under its journaled LID identity', async () => {
      const agent = makeRuntime({ sessionScope: 'per_chat' });
      const seqA = await migrateOpenLidImageBuffer(agent, makeIngest(agent));
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

      // No echo: the answer op stays submitted, so the turn transfers to its recovery owner.
      echoOnSubmit = false;
      const mark = markSends();
      await flushImageCoalesce(PHONE_JID);
      (await waitForInFlightTurn((t) => t.includes('[2 images received]')))
        .emit({ type: 'result', text: 'Two photos received.' });

      await waitForOutcome(seqA);
      expect({
        ...answeredState(seqA, mark),
        errors: finalizeErrors,
        sourceMessageId: finalizeCalls.at(-1)?.recoveryJob?.sourceMessageId,
      }).toEqual({
        ...answeredExpectation(seqA, {
          key: LID_LOCAL,
          jid: LID_JID,
          text: 'Two photos received.',
          disposition: 'transferred_to_recovery_owner',
          status: 'submitted',
        }),
        errors: [],
        sourceMessageId: 'wamid-img-a',
      });
      await expectCleanShutdown();
      expect(sendsSince(mark)).toEqual([[LID_JID, 'Two photos received.']]);
    });

    it('per_chat: a queued LID turn that runs after the migration is answered under its LID identity', async () => {
      dropMapping();
      const agent = makeRuntime({ sessionScope: 'per_chat' });
      const ingest = makeIngest(agent);
      ingest(customerMsg(LID_JID, 'wamid-o1', { content: 'hello' }));
      const first = await waitForInFlightTurn((t) => t.includes('hello'));
      ingest(customerMsg(LID_JID, 'wamid-o2', { content: 'again' }));
      await drainIngest();
      const seq2 = inboundSeqByMessageId('wamid-o2');
      // Turn 1's published context defers the lane's rekey to its terminal.
      agent.handleJidAliasChanged(LID_LOCAL, PHONE_JID);
      upsertLidMapping(db, LID_LOCAL, PHONE_JID);

      suppressReply(first);
      const mark = markSends();
      (await waitForInFlightTurn((t) => t.includes('again'))).emit({ type: 'result', text: 'reply two' });

      await expectAnswered(seq2, { key: LID_LOCAL, jid: LID_JID, text: 'reply two' }, mark);
      await expectCleanShutdown();
      expect(sendsSince(mark)).toEqual([[LID_JID, 'reply two']]);
    });

    for (const sessionScope of ['per_chat', 'single'] as const) {
      it(`${sessionScope}: a scheduled job reporting to a mapped LID is answered under the phone key`, async () => {
        const agent = makeRuntime({ sessionScope });
        const seq = dispatchJob(agent);
        const mark = markSends();
        (await waitForScheduledTurn()).emit({ type: 'result', text: 'Overnight summary: nothing pending.' });

        await expectAnswered(seq, { key: PHONE_DIGITS, jid: LID_JID, text: 'Overnight summary: nothing pending.' }, mark);
        await expectCleanShutdown();
        expect(sendsSince(mark)).toEqual([[LID_JID, 'Overnight summary: nothing pending.']]);
      });
    }
  });

  describe('a queue rebuilt for the turn\'s provider result', () => {
    it('per_chat: the turn resumes on the rebuilt queue and is answered under its LID identity', async () => {
      dropMapping();
      const agent = makeRuntime({ sessionScope: 'per_chat' });
      const { session, seq } = await openCustomerTurn(agent, LID_JID, 'wamid-p1', 'hello');
      addMapping();
      const q1 = internals().chatQueues.get(LID_JID);
      internals().chatQueues.delete(LID_JID);

      const mark = markSends();
      session.emit({ type: 'result', text: 'reply' });
      await waitForOutcome(seq);
      const rebuilt = internals().chatQueues.get(LID_JID);
      expect({
        rebuilt: rebuilt !== undefined && rebuilt !== q1,
        lastOp: lastOps(1),
        alerts: alertFields(),
        terminal: terminalRecords(seq),
        health: health(),
      }).toEqual({
        rebuilt: true,
        lastOp: [{ conversation_key: LID_LOCAL, chat_jid: LID_JID, source_inbound_seq: seq, status: 'echoed' }],
        alerts: [],
        terminal: [{ conversation_key: LID_LOCAL, inbound_disposition: 'finalized_replied' }],
        health: { retained: 0, degraded: 0 },
      });
      await expectAnswered(seq, { key: LID_LOCAL, jid: LID_JID, text: 'reply' }, mark);
      await expectCleanShutdown();
      expect(sendsSince(mark)).toEqual([[LID_JID, 'reply']]);
    });

    it.each(['single', 'shared'] as const)(
      '%s: the turn resumes on the rebuilt queue and is answered under its LID identity',
      async (sessionScope) => {
        dropMapping();
        const agent = makeRuntime({ sessionScope });
        const { session, seq } = await openCustomerTurn(agent, LID_JID, 'wamid-p2', 'hello');
        addMapping();
        const scopeQueue = () => (sessionScope === 'single'
          ? internals().queue
          : internals().outboundQueues.get(LID_JID) ?? null);
        const lost = scopeQueue();
        if (sessionScope === 'single') internals().queue = null;
        else internals().outboundQueues.delete(LID_JID);

        const mark = markSends();
        session.emit({ type: 'result', text: 'reply' });
        await waitForOutcome(seq);
        const rebuilt = scopeQueue();
        expect({
          rebuilt: rebuilt !== null && rebuilt !== lost,
          lastOp: lastOps(1),
          alerts: alertFields(),
          terminal: terminalRecords(seq),
          health: health(),
        }).toEqual({
          rebuilt: true,
          lastOp: [{ conversation_key: LID_LOCAL, chat_jid: LID_JID, source_inbound_seq: seq, status: 'echoed' }],
          alerts: [],
          terminal: [{ conversation_key: LID_LOCAL, inbound_disposition: 'finalized_replied' }],
          health: { retained: 0, degraded: 0 },
        });
        await expectAnswered(seq, { key: LID_LOCAL, jid: LID_JID, text: 'reply' }, mark);
        await expectCleanShutdown();
        expect(sendsSince(mark)).toEqual([[LID_JID, 'reply']]);
      },
    );
  });

  describe('single scope: a second chat on the singleton queue', () => {
    it('single: a second chat\'s answer is redacted for that chat, not for the first chat', async () => {
      mockConfig.internalPeerJids = new Set([A_JID]);
      const agent = makeRuntime({ sessionScope: 'single' });
      const ingest = makeIngest(agent);
      // A's turn creates the singleton queue for A, and finalizes.
      await answerCustomer(ingest, A_JID, 'wamid-s1', 'hi', 'ok');

      const mark = markSends();
      ingest(customerMsg(B_JID, 'wamid-s2', { content: 'where is it?' }));
      (await waitForInFlightTurn((t) => t.includes('where is it?')))
        .emit({ type: 'result', text: 'see /home/testuser/project/notes.md' });
      await drainIngest();
      const seqB = inboundSeqByMessageId('wamid-s2');

      await expectAnswered(seqB, { key: B_KEY, jid: B_JID, text: 'see internal-path' }, mark);
      await expectCleanShutdown();
      expect(sendsSince(mark)).toEqual([[B_JID, 'see internal-path']]);
    });

    it('single: a second chat\'s own client output policy withholds its answer', async () => {
      mockConfig.clientOutputPolicies = registryFor({ ...STRICT_POLICY, conversationKey: B_KEY });
      const agent = makeRuntime({ sessionScope: 'single' });
      const ingest = makeIngest(agent);
      // A has no policy.
      await answerCustomer(ingest, A_JID, 'wamid-s3', 'hi', 'ok');

      const mark = markSends();
      ingest(customerMsg(B_JID, 'wamid-s4', { content: 'a question' }));
      (await waitForInFlightTurn((t) => t.includes('a question'))).emit({ type: 'result', text: 'a zebracorn reply' });
      await drainIngest();
      const seqB = inboundSeqByMessageId('wamid-s4');

      await waitForOutcome(seqB);
      expect({
        terminal: terminalRecords(seqB),
        ops: answerOps(seqB),
        sends: sendsSince(mark),
        health: health(),
      }).toEqual({
        terminal: [{ conversation_key: B_KEY, inbound_disposition: 'finalized_no_reply_policy' }],
        ops: [],
        sends: [],
        health: { retained: 0, degraded: 0 },
      });
      await expectCleanShutdown();
      expect(sendsSince(mark)).toEqual([]);
    });

    it('single: a second chat\'s voice reply goes to that chat', async () => {
      mockConfig.voiceReply = 'always';
      mockSynthesizeSpeech.mockResolvedValue({ buffer: Buffer.from('audio'), duration: 3, mimeType: 'audio/mpeg' });
      const agent = makeRuntime({ sessionScope: 'single' });
      const ingest = makeIngest(agent);
      await answerCustomer(ingest, A_JID, 'wamid-v1', 'hi', 'ok');
      await vi.waitFor(() => expect(transport.media.map(([jid]) => jid)).toEqual([A_JID]), SEND_WAIT);

      const mark = markSends();
      ingest(customerMsg(B_JID, 'wamid-v2', { content: 'and me' }));
      (await waitForInFlightTurn((t) => t.includes('and me'))).emit({ type: 'result', text: 'b reply' });
      await drainIngest();
      const seqB = inboundSeqByMessageId('wamid-v2');

      // Settles in every state: a retained B, or a finalized B whose voice has gone out.
      await vi.waitFor(() => {
        expect(
          health().retained >= 1 || (terminalRecords(seqB).length > 0 && mediaSince(mark).length > 0),
        ).toBe(true);
      }, SEND_WAIT);
      expect({
        terminal: terminalRecords(seqB),
        retained: health().retained,
        media: mediaSince(mark).map(([jid, media]) => [jid, media.type, media.ptt]),
      }).toEqual({
        terminal: [{ conversation_key: B_KEY, inbound_disposition: 'finalized_replied' }],
        retained: 0,
        media: [[B_JID, 'audio', true]],
      });
      await expectCleanShutdown();
      expect({ sends: sendsSince(mark), media: mediaSince(mark).map(([jid]) => jid) })
        .toEqual({ sends: [[B_JID, 'b reply']], media: [B_JID] });
    });
  });

  describe('a queue created by a provider-fallback session replacement', () => {
    it('per_chat: a held turn replayed onto a fallback-created queue resumes there under its LID identity', async () => {
      dropMapping();
      const agent = makeRuntime({ sessionScope: 'per_chat' });
      let mark = markSends();
      try {
        const { seq } = await openCustomerTurn(agent, LID_JID, 'wamid-f1', 'hello');
        const ctx = internals().runtimeTurnCoordinator.runtimeTurnContext(LID_JID);
        expect(ctx?.identity).toMatchObject({ conversationKey: LID_LOCAL, deliveryJid: LID_JID, inboundSeq: seq });
        // Raw SQL: no alias event, so no rekey. The new queue is created after the
        // mapping, so its own key is the phone key while the turn's is the LID key.
        addMapping();
        const q1 = internals().chatQueues.get(LID_JID);
        internals().chatQueues.delete(LID_JID);
        // Production shuts the old session down and discards it before the recreate.
        // Shutting the double down here would let its dispatch continue mid-case.
        const discarded = internals().discardPerChatSessionForFallback(LID_JID, sessionDoubles[0]!);
        internals().recreatePerChatSessionForFallback(LID_JID, LID_JID, undefined, undefined, ctx!);
        const q = internals().chatQueues.get(LID_JID);

        mark = markSends();
        q?.enqueueText('fallback reply');
        await waitForEchoedSend('fallback reply', mark);
        const flush = q ? await settle(q.flushTurnEvidence(ctx!.identity.logicalTurnId)) : null;

        expect({
          discarded,
          created: q !== undefined && q !== q1,
          op: opsByText('fallback reply'),
          flush,
        }).toEqual({
          discarded: true,
          created: true,
          op: [{ conversation_key: LID_LOCAL, chat_jid: LID_JID, source_inbound_seq: seq, status: 'echoed' }],
          flush: { ok: true, turnId: ctx!.identity.logicalTurnId },
        });
      } finally {
        settleOpenProviderTurns();
      }
      await expectCleanShutdown();
      expect(sendsSince(mark)).toEqual([[LID_JID, 'fallback reply']]);
    });

    it.each(['per_chat', 'single', 'shared'] as const)(
      '%s: a fallback recreate leaves a kept queue and its completed evidence untouched',
      async (sessionScope) => {
        const agent = makeRuntime({ sessionScope });
        await openCustomerTurn(agent, A_JID, 'wamid-k1', 'hello');
        const mark = markSends();
        try {
          const ctx = sessionScope === 'per_chat'
            ? internals().runtimeTurnCoordinator.runtimeTurnContext(A_JID)
            : internals().runtimeTurnCoordinator.runtimeTurnContext();
          const keptQueue = () => (sessionScope === 'per_chat'
            ? internals().chatQueues.get(A_JID) ?? null
            : sessionScope === 'single' ? internals().queue : internals().outboundQueues.get(A_JID) ?? null);
          const q1 = keptQueue();
          // The kept queue now holds this turn's completed evidence, so a resume on it
          // would throw; for the same turn's active evidence a begin only returns early.
          await q1?.flushTurnEvidence(ctx!.identity.logicalTurnId);
          // The singleton recreate replaces the session with no ownership check.
          const discarded = sessionScope === 'per_chat'
            ? internals().discardPerChatSessionForFallback(A_JID, sessionDoubles[0]!)
            : 'n/a';
          let threw = false;
          try {
            if (sessionScope === 'per_chat') {
              internals().recreatePerChatSessionForFallback(A_JID, A_JID, undefined, undefined, ctx!);
            } else {
              internals().recreateSingletonSessionForFallback(A_JID, undefined, undefined, ctx!);
            }
          } catch {
            threw = true;
          }

          expect({ discarded, same: keptQueue() === q1, threw }).toEqual({
            discarded: sessionScope === 'per_chat' ? true : 'n/a',
            same: true,
            threw: false,
          });
        } finally {
          settleOpenProviderTurns();
        }
        await expectCleanShutdown();
        expect(sendsSince(mark)).toEqual([]);
      },
    );

    it.each(['single', 'shared'] as const)(
      '%s: a held turn replayed onto a fallback-created queue resumes there under its LID identity',
      async (sessionScope) => {
        dropMapping();
        const agent = makeRuntime({ sessionScope });
        let mark = markSends();
        try {
          // The first message creates the scope's queue for the LID chat before the mapping.
          const { seq } = await openCustomerTurn(agent, LID_JID, 'wamid-g1', 'hello');
          const ctx = internals().runtimeTurnCoordinator.runtimeTurnContext();
          expect(ctx?.identity).toMatchObject({ conversationKey: LID_LOCAL, deliveryJid: LID_JID, inboundSeq: seq });
          addMapping();
          const scopeQueue = () => (sessionScope === 'single'
            ? internals().queue
            : internals().outboundQueues.get(LID_JID) ?? null);
          const old = scopeQueue();
          if (sessionScope === 'single') internals().queue = null;
          else internals().outboundQueues.delete(LID_JID);
          internals().recreateSingletonSessionForFallback(LID_JID, undefined, undefined, ctx!);
          const q = scopeQueue();

          mark = markSends();
          q?.enqueueText('fallback reply');
          await waitForEchoedSend('fallback reply', mark);
          const flush = q ? await settle(q.flushTurnEvidence(ctx!.identity.logicalTurnId)) : null;

          expect({
            created: q !== null && q !== old,
            op: opsByText('fallback reply'),
            flush,
          }).toEqual({
            created: true,
            op: [{ conversation_key: LID_LOCAL, chat_jid: LID_JID, source_inbound_seq: seq, status: 'echoed' }],
            flush: { ok: true, turnId: ctx!.identity.logicalTurnId },
          });
        } finally {
          settleOpenProviderTurns();
        }
        await expectCleanShutdown();
        expect(sendsSince(mark)).toEqual([[LID_JID, 'fallback reply']]);
      },
    );

    it('shared: a fallback recreate for another chat does not resume the held turn there', async () => {
      const agent = makeRuntime({ sessionScope: 'shared' });
      await openCustomerTurn(agent, B_JID, 'wamid-h1', 'hello');
      const mark = markSends();
      try {
        const ctx = internals().runtimeTurnCoordinator.runtimeTurnContext();
        const qB = internals().outboundQueues.get(B_JID);
        internals().outboundQueues.delete(A_JID);
        internals().recreateSingletonSessionForFallback(A_JID, undefined, undefined, ctx!);
        const qA = internals().outboundQueues.get(A_JID);
        const aFlush = qA ? await settle(qA.flushTurnEvidence(ctx!.identity.logicalTurnId)) : null;

        expect({ aFlush, bSame: internals().outboundQueues.get(B_JID) === qB }).toEqual({
          aFlush: { ok: false, message: `No active turn evidence belongs to ${ctx!.identity.logicalTurnId}` },
          bSame: true,
        });
      } finally {
        settleOpenProviderTurns();
      }
      await expectCleanShutdown();
      expect(sendsSince(mark)).toEqual([]);
    });

    it.each(['per_chat', 'single'] as const)(
      '%s: the replay hands the held turn context through the runtime to the recreate',
      async (sessionScope) => {
        const agent = makeRuntime({ sessionScope });
        await openCustomerTurn(agent, A_JID, 'wamid-w1', 'hello');
        const mark = markSends();
        try {
          const ctx = sessionScope === 'per_chat'
            ? internals().runtimeTurnCoordinator.runtimeTurnContext(A_JID)
            : internals().runtimeTurnCoordinator.runtimeTurnContext();
          // The recreate is stubbed to throw, so no session spawns and the replay stops there.
          const spy = vi.spyOn(
            internals() as unknown as Record<string, (...args: unknown[]) => void>,
            sessionScope === 'per_chat' ? 'recreatePerChatSessionForFallback' : 'recreateSingletonSessionForFallback',
          ).mockImplementation(() => {
            throw new Error('stop-after-recreate');
          });
          // With no old session and no route override, the replay goes straight to the recreate.
          const result = await settle(internals().runtimeTurnCoordinator.replayTurnOnFallback({
            chatJid: A_JID,
            ...(sessionScope === 'per_chat' ? { mapKey: A_JID } : {}),
            replayText: 'r',
            oldSession: null,
            runtimeContext: ctx!,
          }));

          expect({ contextPassed: spy.mock.calls.map((call) => call.at(-1) === ctx), result }).toEqual({
            contextPassed: [true],
            result: { ok: false, message: 'stop-after-recreate' },
          });
        } finally {
          settleOpenProviderTurns();
        }
        await expectCleanShutdown();
        expect(sendsSince(mark)).toEqual([]);
      },
    );
  });

  it('shared: a system result for another chat is sent under that chat\'s identity, not the dispatched turn\'s', async () => {
    const agent = makeRuntime({ sessionScope: 'shared' });
    // B is the shared session's first chat, so shutdown finalizes B's turn on B's own queue.
    const { session } = await openCustomerTurn(agent, B_JID, 'wamid-e1', 'hello');
    const ctx = internals().runtimeTurnCoordinator.runtimeTurnContext();
    // A pending system turn for A, admitted while B's runtime turn is dispatched.
    internals().pendingSystemResults.mark({
      scopeKey: GLOBAL_TOOL_SCOPE,
      purpose: 'respawn_continuation',
      owner: internals().captureSystemTurnOwner(session, GLOBAL_TOOL_SCOPE),
      routeChatJid: A_JID,
    });
    internals().outboundQueues.delete(A_JID);

    // Only a result rebuilds a missing queue.
    const mark = markSends();
    session.emit({ type: 'result', text: 'system text' });
    await vi.waitFor(() => {
      if (opsByText('system text').length === 0 || !sendsSince(mark).some(([, text]) => text === 'system text')) {
        throw new Error('system text not yet sent');
      }
    }, SEND_WAIT);
    const qA = internals().outboundQueues.get(A_JID);
    const bEvidenceOnA = qA ? (await settle(qA.flushTurnEvidence(ctx!.identity.logicalTurnId))).ok : null;

    expect({ aOps: opsByText('system text'), sends: sendsSince(mark), bEvidenceOnA }).toEqual({
      aOps: [{ conversation_key: A_KEY, chat_jid: A_JID, source_inbound_seq: null, status: 'echoed' }],
      sends: [[A_JID, 'system text']],
      bEvidenceOnA: false,
    });
    await expectCleanShutdown();
    expect(sendsSince(mark)).toEqual([[A_JID, 'system text']]);
  });
});
