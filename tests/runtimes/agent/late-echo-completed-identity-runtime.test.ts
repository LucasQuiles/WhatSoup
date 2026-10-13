// A completed per-chat turn whose answer was submitted but not yet echoed is
// transferred to a recovery owner, so its terminal leaves the checkpoint's
// completed identity unset. When the transport's echo later reaches ingest,
// the echo settlement records that identity. These cases drive that path end
// to end and check what a waiting follower and a restart then observe.
//
// Harness: REAL AgentRuntime + REAL OutboundQueue + REAL SQLite durability +
// REAL ingest (as in lid-answer-attribution.test.ts). The echo arrives as an
// isFromMe message through ingest: ingest stores the outgoing message and
// calls the real matchEcho, nothing on that path is spied or stubbed. The
// provider session is a double. It makes the real SessionManager's lifecycle
// writes through the real durability engine under the same persistence key
// (session.ts: beginFreshSessionLifecycle at spawn, the init event's session
// id, closeSessionLifecycle at shutdown). The other doubles are configuration,
// the logger, alerts, access policy, command routing, message-history reads,
// media preparation and bridging, session-db helpers and classification, the
// workspace, the MCP socket server and tool registration, and file writes.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Messenger, IncomingMessage } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';

// ─── Hoisted provider-boundary doubles ──────────────────────────────────────

const { sessionDoubles, resetDoubles, makeSessionDouble, lifecycleRef } = vi.hoisted(() => {
  type Lifecycle = {
    begin(conversationKey: string, chatJid: string, pid: number, sessionId: string): number;
    close(rowId: number, sessionId: string, conversationKey: string, status: 'suspended' | 'ended'): void;
  };
  const lifecycleRef: { current: Lifecycle | null; toConversationKey: ((jid: string) => string) | null } = {
    current: null,
    toConversationKey: null,
  };
  type SessionCtorOpts = {
    chatJid: string;
    persistenceConversationKey?: string;
    onEvent: (event: AgentEvent) => void;
  };
  let nextPid = 6200;

  function makeSessionDouble(opts: SessionCtorOpts) {
    // The real manager's persistence key (session.ts constructor).
    const conversationKey = opts.persistenceConversationKey ?? lifecycleRef.toConversationKey!(opts.chatJid);
    nextPid += 1;
    const pid = nextPid;
    let active = false;
    let sessionId: string | null = null;
    let rowId: number | null = null;
    let pendingResolve: (() => void) | null = null;
    let pendingPromise: Promise<void> = Promise.resolve();
    const double = {
      ctorOpts: opts,
      conversationKey,
      turnsSent: [] as unknown[],
      get turnInFlight(): boolean {
        return pendingResolve !== null;
      },
      emit(event: AgentEvent): void {
        opts.onEvent(event);
      },
      spawnSession: vi.fn(async (resumeSessionId?: string) => {
        active = true;
        if (resumeSessionId !== undefined) {
          sessionId = resumeSessionId;
          return;
        }
        sessionId = `sess-${conversationKey}-${pid}`;
        rowId = lifecycleRef.current!.begin(conversationKey, opts.chatJid, pid, sessionId);
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
        pid: active ? pid : null,
        sessionId: active ? sessionId : null,
        startedAt: active ? new Date().toISOString() : null,
        messageCount: 0,
        lastMessageAt: null as string | null,
      })),
      // The real default suspends (session.ts shutdown(suspend = true)).
      shutdown: vi.fn(async (suspend = true) => {
        if (active && rowId !== null && sessionId !== null) {
          lifecycleRef.current!.close(rowId, sessionId, conversationKey, suspend ? 'suspended' : 'ended');
        }
        active = false;
      }),
      reapWedgedProviderChild: vi.fn(() => true),
      clearTurnWatchdog: vi.fn(),
      tickWatchdog: vi.fn(),
      trackToolStart: vi.fn(),
      trackToolEnd: vi.fn(),
      getDbRowId: vi.fn(() => rowId),
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

  return { sessionDoubles, resetDoubles, makeSessionDouble, lifecycleRef };
});

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    agentProvider: 'claude-cli',
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set<string>(['15550001']),
    controlPeers: new Map<string, string>(),
    internalPeerJids: new Set<string>(),
    // The real queue reads the echo guard before every send; disabled, it never drops one.
    echoGuard: { enabled: false },
    toolUpdateMode: 'full' as const,
    toolUpdateRedirectJid: null as string | null,
    textAggregateDelayMs: 2_000,
    stateRoot: `/tmp/whatsoup-test-state-late-echo-runtime-${process.pid}`,
    restartLoopGuard: { enabled: false, maxRestarts: 3, windowMs: 300_000 },
    startupNotifications: false,
    proactiveResumeOnStartup: false,
    mediaDir: `/tmp/whatsoup-test-media-late-echo-runtime-${process.pid}`,
    pineconeAllowedIndexes: [] as string[],
    voiceReply: 'never' as const,
    elevenlabs: { defaultVoiceId: 'v', defaultModel: 'm', stability: 0.5, similarityBoost: 0.75 },
    memory: { adminJid: 'admin@s.whatsapp.net' },
  },
}));

// ─── Module mocks (provider boundary + side-effect surfaces) ────────────────

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
  }) {
    const double = makeSessionDouble(opts);
    sessionDoubles.push(double);
    return double;
  }),
  formatAge: vi.fn(() => 'now'),
  getProviderBinary: vi.fn(() => null),
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
  WhatSoupSocketServer: vi.fn().mockImplementation(function () {
    return {
      start: vi.fn(),
      stop: vi.fn(),
      updateDeliveryJid: vi.fn(),
      updateActorJid: vi.fn(),
      updateConversationKey: vi.fn(),
    };
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
import { createIngestHandler } from '../../../src/core/ingest.ts';
import { toConversationKey } from '../../../src/core/conversation-key.ts';
import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { installFakePerChatMcpSocketManager } from './helpers/fake-per-chat-mcp-socket-manager.ts';
import { drainIngest } from '../../core/_helpers/ingest-drain.ts';
import { prepareRuntimeHome } from '../../helpers/runtime-home-fixture.ts';

// ─── Fixtures (synthetic identities only) ───────────────────────────────────

const BOT_JID = '15550000@s.whatsapp.net';
const DM_KEY = '15550008101';
const DM_JID = `${DM_KEY}@s.whatsapp.net`;
// The real queue paces sends 500 ms apart; the follower's echo wait is 10 s.
const SEND_WAIT = { timeout: 8_000, interval: 10 };

type SessionDouble = (typeof sessionDoubles)[number];

/** Ingest's own transport; the runtime sends on the recording transport. */
function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

/** The runtime's transport: records each send and returns a distinct WhatsApp id. Nothing echoes by itself. */
function makeRecordingTransport(): { messenger: Messenger; texts: Array<[string, string, string]> } {
  const texts: Array<[string, string, string]> = [];
  const messenger = {
    sendMessage: vi.fn(async (jid: string, text: string) => {
      const waMessageId = `wa-late-echo-${texts.length + 1}`;
      texts.push([jid, text, waMessageId]);
      return { waMessageId };
    }),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
  return { messenger, texts };
}

function customerMsg(chatJid: string, messageId: string, content: string): IncomingMessage {
  return {
    messageId,
    chatJid,
    senderJid: chatJid,
    senderName: 'Customer',
    content,
    contentText: null,
    contentType: 'text',
    isFromMe: false,
    isGroup: false,
    mentionedJids: [],
    timestamp: Math.floor(Date.now() / 1000),
    quotedMessageId: null,
    isResponseWorthy: true,
  };
}

/** The transport's echo of the bot's own send, as WhatsApp delivers it to ingest. */
function echoMsg(chatJid: string, waMessageId: string, content: string): IncomingMessage {
  return {
    ...customerMsg(chatJid, waMessageId, content),
    senderJid: BOT_JID,
    senderName: null,
    isFromMe: true,
    isResponseWorthy: false,
  };
}

function turnText(input: unknown): string {
  if (typeof input === 'string') return input;
  const structured = input as { userText?: string; applicationContext?: readonly string[] };
  return [structured.applicationContext?.join('\n') ?? '', structured.userText ?? ''].join('\n');
}

async function waitForInFlightTurn(matches: (text: string) => boolean, timeout = 4_000): Promise<SessionDouble> {
  let found: SessionDouble | undefined;
  await vi.waitFor(() => {
    found = sessionDoubles.find((s) => s.turnInFlight && matches(turnText(s.turnsSent.at(-1))));
    expect(found).toBeDefined();
  }, { timeout });
  return found!;
}

describe('late delivery echo through ingest records the completed identity', () => {
  let db: Database;
  let engine: DurabilityEngine;
  let runtime: AgentRuntime | undefined;
  let transport: ReturnType<typeof makeRecordingTransport>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDoubles();
    mockConfig.proactiveResumeOnStartup = false;
    transport = makeRecordingTransport();
    db = new Database(':memory:');
    db.open();
    engine = new DurabilityEngine(db);
    lifecycleRef.toConversationKey = toConversationKey;
    lifecycleRef.current = {
      begin: (conversationKey, chatJid, pid, sessionId) => {
        const rowId = engine.beginFreshSessionLifecycle({
          pid, cwd: '/tmp/late-echo-runtime', chatJid, workspaceKey: conversationKey,
          provider: 'claude-cli', conversationKey,
        });
        // The init event (session.ts handleProviderEvent): the row and checkpoint learn the provider session id.
        db.raw.prepare('UPDATE agent_sessions SET session_id = ? WHERE id = ?').run(sessionId, rowId);
        engine.upsertSessionCheckpoint(conversationKey, { sessionId });
        return rowId;
      },
      close: (rowId, sessionId, conversationKey, status) => {
        engine.closeSessionLifecycle({
          agentSessionRowId: rowId, providerSessionId: sessionId, provider: 'claude-cli',
          conversationKey, status,
        });
      },
    };
  });

  afterEach(async () => {
    for (const session of sessionDoubles) {
      if (session.turnInFlight) session.emit({ type: 'result', text: 'NO_REPLY' });
    }
    await runtime?.shutdown().catch(() => undefined);
    runtime = undefined;
    lifecycleRef.current = null;
    db.close();
  });

  function makeRuntime(): AgentRuntime {
    const created = new AgentRuntime(db, transport.messenger, 'test', { sessionScope: 'per_chat' });
    installFakePerChatMcpSocketManager(created);
    created.setDurability(engine);
    runtime = created;
    return created;
  }

  function makeIngest(agent: AgentRuntime): (msg: IncomingMessage) => void {
    return createIngestHandler(db, makeMessenger(), agent, () => BOT_JID, () => null, engine);
  }

  function inboundSeqByMessageId(messageId: string): number {
    const row = db.raw.prepare('SELECT seq FROM inbound_events WHERE message_id = ?').get(messageId) as
      | { seq: number }
      | undefined;
    if (row === undefined) throw new Error(`no inbound row for ${messageId}`);
    return row.seq;
  }

  function inbound(seq: number): { processing_status: string; terminal_reason: string | null; conversation_key: string } {
    return db.raw.prepare(
      'SELECT processing_status, terminal_reason, conversation_key FROM inbound_events WHERE seq = ?',
    ).get(seq) as { processing_status: string; terminal_reason: string | null; conversation_key: string };
  }

  function terminal(seq: number) {
    return db.raw.prepare(
      `SELECT conversation_key, delivery_jid, inbound_disposition, logical_turn_id, manager_id, generation
       FROM turn_terminal_records WHERE inbound_seq = ?`,
    ).all(seq) as Array<{
      conversation_key: string;
      delivery_jid: string;
      inbound_disposition: string;
      logical_turn_id: string;
      manager_id: string;
      generation: number;
    }>;
  }

  function answerOp(seq: number): { id: number; conversation_key: string; chat_jid: string; status: string; wa_message_id: string | null } {
    return db.raw.prepare(
      `SELECT id, conversation_key, chat_jid, status, wa_message_id FROM outbound_ops
       WHERE source_inbound_seq = ? AND is_terminal = 1 ORDER BY id`,
    ).get(seq) as { id: number; conversation_key: string; chat_jid: string; status: string; wa_message_id: string | null };
  }

  function storedOutgoing(messageId: string): Array<{ conversation_key: string; chat_jid: string; is_from_me: number }> {
    return db.raw.prepare(
      'SELECT conversation_key, chat_jid, is_from_me FROM messages WHERE message_id = ?',
    ).all(messageId) as Array<{ conversation_key: string; chat_jid: string; is_from_me: number }>;
  }

  function completedIdentity(conversationKey: string) {
    return db.raw.prepare(
      `SELECT completed_inbound_seq, completed_delivery_jid, completed_scope, completed_logical_turn_id,
              completed_manager_id, completed_generation
       FROM session_checkpoints WHERE conversation_key = ?`,
    ).get(conversationKey) as Record<string, unknown> | undefined;
  }

  function recoveryJob(seq: number): { state: string; completion_kind: string | null } | undefined {
    return db.raw.prepare(
      'SELECT state, completion_kind FROM turn_recovery_jobs WHERE source_inbound_seq = ?',
    ).get(seq) as { state: string; completion_kind: string | null } | undefined;
  }

  /**
   * One customer turn answered with `answer` and no echo yet: the turn ends
   * with its answer submitted and is transferred to its recovery owner.
   */
  async function answerWithoutEcho(
    ingest: (msg: IncomingMessage) => void,
    chatJid: string,
    messageId: string,
    content: string,
    answer: string,
  ): Promise<{ seq: number; session: SessionDouble; waMessageId: string }> {
    ingest(customerMsg(chatJid, messageId, content));
    const session = await waitForInFlightTurn((t) => t.includes(content));
    await drainIngest();
    const seq = inboundSeqByMessageId(messageId);
    session.emit({ type: 'result', text: answer });
    await vi.waitFor(() => expect(terminal(seq)).toHaveLength(1), SEND_WAIT);
    const sent = transport.texts.find(([, text]) => text === answer);
    expect(sent).toBeDefined();
    return { seq, session, waMessageId: sent![2] };
  }

  it('the echo through ingest settles the transferred turn and records its exact completed identity', async () => {
    const agent = makeRuntime();
    const ingest = makeIngest(agent);
    const { seq, session, waMessageId } = await answerWithoutEcho(ingest, DM_JID, 'wamid-l1', 'hello', 'reply one');

    expect({
      terminal: terminal(seq).map(({ conversation_key, delivery_jid, inbound_disposition }) =>
        ({ conversation_key, delivery_jid, inbound_disposition })),
      op: answerOp(seq).status,
      job: recoveryJob(seq)?.state,
      admission: engine.getTurnRecoveryAdmissionStateForScope('per_chat', DM_KEY),
      completed: completedIdentity(DM_KEY)?.completed_inbound_seq,
      session: session.conversationKey,
    }).toEqual({
      terminal: [{ conversation_key: DM_KEY, delivery_jid: DM_JID, inbound_disposition: 'transferred_to_recovery_owner' }],
      op: 'submitted',
      job: 'pending',
      admission: 'awaiting_delivery_echo',
      completed: null,
      session: DM_KEY,
    });

    ingest(echoMsg(DM_JID, waMessageId, 'reply one'));
    await drainIngest();

    const [record] = terminal(seq);
    expect({
      stored: storedOutgoing(waMessageId),
      op: answerOp(seq).status,
      job: recoveryJob(seq),
      inbound: inbound(seq),
      admission: engine.getTurnRecoveryAdmissionStateForScope('per_chat', DM_KEY),
      completed: completedIdentity(DM_KEY),
    }).toEqual({
      stored: [{ conversation_key: DM_KEY, chat_jid: DM_JID, is_from_me: 1 }],
      op: 'echoed',
      job: { state: 'completed', completion_kind: 'echo' },
      inbound: { processing_status: 'complete', terminal_reason: 'response_echoed', conversation_key: DM_KEY },
      admission: 'clear',
      completed: {
        completed_inbound_seq: seq,
        completed_delivery_jid: DM_JID,
        completed_scope: 'per_chat',
        completed_logical_turn_id: record!.logical_turn_id,
        completed_manager_id: record!.manager_id,
        completed_generation: record!.generation,
      },
    });
  });

  it('a follower waiting on the delivery echo is dispatched once the echo arrives through ingest', async () => {
    const agent = makeRuntime();
    const ingest = makeIngest(agent);
    const { seq, session, waMessageId } = await answerWithoutEcho(ingest, DM_JID, 'wamid-w1', 'first', 'reply first');

    ingest(customerMsg(DM_JID, 'wamid-w2', 'second'));
    await drainIngest();
    const follower = inboundSeqByMessageId('wamid-w2');
    // The follower is admitted only after the echo: it stays processing with no provider turn.
    await vi.waitFor(() => expect(inbound(follower).processing_status).toBe('processing'), SEND_WAIT);
    expect(session.turnsSent.map(turnText).filter((t) => t.includes('second'))).toEqual([]);
    expect(engine.getTurnRecoveryAdmissionStateForScope('per_chat', DM_KEY)).toBe('awaiting_delivery_echo');

    ingest(echoMsg(DM_JID, waMessageId, 'reply first'));
    await drainIngest();

    expect(completedIdentity(DM_KEY)?.completed_inbound_seq).toBe(seq);
    const next = await waitForInFlightTurn((t) => t.includes('second'), SEND_WAIT.timeout);
    expect(next).toBe(session);
    expect(inbound(follower).processing_status).toBe('processing');
    next.emit({ type: 'result', text: 'NO_REPLY' });
  });

  it('after the late echo, a restart proactively resumes the chat\'s own session', async () => {
    const agent = makeRuntime();
    const ingest = makeIngest(agent);
    const { session, waMessageId } = await answerWithoutEcho(ingest, DM_JID, 'wamid-r1', 'hello', 'reply one');
    const sessionId = session.getStatus().sessionId;
    ingest(echoMsg(DM_JID, waMessageId, 'reply one'));
    await drainIngest();

    await agent.shutdown();
    runtime = undefined;
    await prepareRuntimeHome();
    const bootIndex = sessionDoubles.length;
    mockConfig.proactiveResumeOnStartup = true;
    const restarted = makeRuntime();
    await restarted.start();

    const resumed = sessionDoubles.slice(bootIndex).find((s) => s.ctorOpts.chatJid === DM_JID);
    expect(resumed).toBeDefined();
    await vi.waitFor(() => expect(resumed!.spawnSession).toHaveBeenCalled());
    expect(resumed!.spawnSession).toHaveBeenCalledWith(sessionId);
    expect(engine.getCompletedDeliveryIdentityAdmissionHealth().unresolvedCount).toBe(0);
  });

  // Known limitation, separate from this fix. A mapped LID DM is journaled,
  // answered and echoed under the phone key, while its session persists under
  // the LID key. The echo still settles the turn, but no live session owns the
  // phone-key checkpoint, so its identity stays unset: the fail-safe of a
  // fresh session, as on main. The witness join is not widened to cover it.
  it('a mapped LID DM settles on its late echo but records no identity across the session key split', async () => {
    const lidLocal = '155500000000081';
    const lidJid = `${lidLocal}@lid`;
    db.raw.prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)').run(lidLocal, DM_JID);
    const agent = makeRuntime();
    const ingest = makeIngest(agent);
    const { seq, session, waMessageId } = await answerWithoutEcho(ingest, lidJid, 'wamid-lid1', 'hello', 'reply lid');

    ingest(echoMsg(lidJid, waMessageId, 'reply lid'));
    await drainIngest();

    expect({
      session: session.conversationKey,
      terminal: terminal(seq).map(({ conversation_key, delivery_jid }) => ({ conversation_key, delivery_jid })),
      stored: storedOutgoing(waMessageId),
      op: answerOp(seq).status,
      job: recoveryJob(seq),
      admission: engine.getTurnRecoveryAdmissionStateForScope('per_chat', DM_KEY),
      completed: [completedIdentity(DM_KEY)?.completed_inbound_seq, completedIdentity(lidLocal)?.completed_inbound_seq],
    }).toEqual({
      session: lidLocal,
      terminal: [{ conversation_key: DM_KEY, delivery_jid: lidJid }],
      stored: [{ conversation_key: DM_KEY, chat_jid: lidJid, is_from_me: 1 }],
      op: 'echoed',
      job: { state: 'completed', completion_kind: 'echo' },
      admission: 'clear',
      completed: [null, null],
    });
  });
});
