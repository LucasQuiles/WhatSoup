// F7 across a real service restart. A stalled-operation kill tells the user
// to send the message again and the killed request is finalized as failed, so
// a restart must not continue that work on the agent's own initiative. The
// kill is saved on the session checkpoint; proactive resume on the next boot
// reads it from SQLite. These cases drive the kill, the shutdown, the restart
// and the user's next request end to end and read the stored rows.
//
// Harness: the late-echo real-database harness
// (late-echo-completed-identity-runtime.test.ts): REAL AgentRuntime + REAL
// OutboundQueue + REAL SQLite durability + REAL ingest. A reply counts as
// delivered only when its outbound op is `echoed` after the transport's echo
// came back through ingest. The provider session is a double; a kill is the
// double reporting a crash through the runtime's own onCrash wiring.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Messenger, IncomingMessage } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';

// ─── Hoisted provider-boundary doubles ──────────────────────────────────────

const { sessionDoubles, resetDoubles, makeSessionDouble, lifecycleRef } = vi.hoisted(() => {
  type Lifecycle = {
    begin(conversationKey: string, chatJid: string, pid: number, sessionId: string): number;
    close(rowId: number, sessionId: string, conversationKey: string, status: 'suspended' | 'ended'): void;
    fail?(rowId: number, sessionId: string, conversationKey: string): void;
    reactivate?(conversationKey: string, pid: number, sessionId: string, rowId?: number): number;
  };
  const lifecycleRef: { current: Lifecycle | null; toConversationKey: ((jid: string) => string) | null } = {
    current: null,
    toConversationKey: null,
  };
  type SessionCtorOpts = {
    chatJid: string;
    persistenceConversationKey?: string;
    onEvent: (event: AgentEvent) => void;
    onCrash?: (info: Record<string, unknown>) => void;
  };
  let nextPid = 7300;

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
      // The real manager's exit path (session.ts closeDurableFailureLifecycle):
      // the agent row is crashed and the checkpoint orphaned.
      killProvider(): void {
        if (active && rowId !== null && sessionId !== null) {
          lifecycleRef.current!.fail!(rowId, sessionId, conversationKey);
        }
        active = false;
      },
      spawnSession: vi.fn(async (resumeSessionId?: string, resumeRowId?: number) => {
        active = true;
        if (resumeSessionId !== undefined) {
          sessionId = resumeSessionId;
          rowId = lifecycleRef.current!.reactivate!(conversationKey, pid, resumeSessionId, resumeRowId);
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
        providerTerminated: !active,
        turnInFlight: pendingResolve !== null,
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
    stateRoot: `/tmp/whatsoup-test-state-f7-restart-real-db-${process.pid}`,
    restartLoopGuard: { enabled: false, maxRestarts: 3, windowMs: 300_000 },
    startupNotifications: false,
    proactiveResumeOnStartup: false,
    mediaDir: `/tmp/whatsoup-test-media-f7-restart-real-db-${process.pid}`,
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
const DM_KEY = '15550008207';
const DM_JID = `${DM_KEY}@s.whatsapp.net`;
const SEND_WAIT = { timeout: 8_000, interval: 10 };
const RESTART_CONTINUATION = 'resumed after service restart';

type SessionDouble = (typeof sessionDoubles)[number];

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
      const waMessageId = `wa-f7-restart-${texts.length + 1}`;
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

describe('F7: a stalled-operation kill survives a real service restart', () => {
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
          pid, cwd: '/tmp/f7-restart-real-db', chatJid, workspaceKey: conversationKey,
          provider: 'claude-cli', conversationKey,
        });
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
      fail: (rowId, sessionId, conversationKey) => {
        engine.closeSessionLifecycleFailure({
          agentSessionRowId: rowId, providerSessionId: sessionId, provider: 'claude-cli',
          conversationKey, agentStatus: 'crashed',
        });
      },
      reactivate: (conversationKey, pid, sessionId, rowId) => {
        const exactRowId = rowId ?? (db.raw.prepare(
          'SELECT id FROM agent_sessions WHERE session_id = ? AND workspace_key = ? ORDER BY id DESC LIMIT 1',
        ).get(sessionId, conversationKey) as { id: number }).id;
        return engine.reactivateSessionLifecycle({
          agentSessionRowId: exactRowId, providerSessionId: sessionId, provider: 'claude-cli',
          pid, workspaceKey: conversationKey, conversationKey,
        });
      },
    };
  });

  afterEach(async () => {
    try {
      for (const session of sessionDoubles) {
        if (session.turnInFlight) session.emit({ type: 'result', text: 'NO_REPLY' });
      }
      await runtime?.shutdown();
    } finally {
      runtime = undefined;
      lifecycleRef.current = null;
      db.close();
    }
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

  function inbound(seq: number): { processing_status: string; terminal_reason: string | null } {
    return db.raw.prepare(
      'SELECT processing_status, terminal_reason FROM inbound_events WHERE seq = ?',
    ).get(seq) as { processing_status: string; terminal_reason: string | null };
  }

  function answerOp(seq: number): { status: string; wa_message_id: string | null } | undefined {
    return db.raw.prepare(
      `SELECT status, wa_message_id FROM outbound_ops
       WHERE source_inbound_seq = ? AND is_terminal = 1 ORDER BY id`,
    ).get(seq) as { status: string; wa_message_id: string | null } | undefined;
  }

  function checkpoint(): { session_id: string | null; session_status: string; watchdog: Record<string, unknown> } {
    const row = db.raw.prepare(
      'SELECT session_id, session_status, watchdog_state FROM session_checkpoints WHERE conversation_key = ?',
    ).get(DM_KEY) as { session_id: string | null; session_status: string; watchdog_state: string | null };
    return {
      session_id: row.session_id,
      session_status: row.session_status,
      watchdog: row.watchdog_state ? JSON.parse(row.watchdog_state) as Record<string, unknown> : {},
    };
  }

  function terminalCount(seq: number): number {
    return (db.raw.prepare('SELECT COUNT(*) AS n FROM turn_terminal_records WHERE inbound_seq = ?').get(seq) as { n: number }).n;
  }

  /** The in-process auto-respawn after the kill: the same manager resumes its session. */
  async function waitForRespawn(session: SessionDouble, sessionId: string): Promise<void> {
    await vi.waitFor(() => {
      expect(session.spawnSession).toHaveBeenLastCalledWith(sessionId, expect.any(Number));
      expect(session.getStatus().active).toBe(true);
    }, { timeout: 20_000, interval: 50 });
    // Let the respawn finish its post-resume step.
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  function sentTexts(session: SessionDouble): string[] {
    return session.turnsSent.map(turnText);
  }

  /** One customer request answered and echoed through ingest: delivered. */
  async function deliveredExchange(
    ingest: (msg: IncomingMessage) => void,
    messageId: string,
    content: string,
    answer: string,
  ): Promise<{ seq: number; session: SessionDouble }> {
    ingest(customerMsg(DM_JID, messageId, content));
    const session = await waitForInFlightTurn((t) => t.includes(content), SEND_WAIT.timeout);
    await drainIngest();
    const seq = inboundSeqByMessageId(messageId);
    session.emit({ type: 'result', text: answer });
    await vi.waitFor(() => expect(terminalCount(seq)).toBe(1), SEND_WAIT);
    await vi.waitFor(() => expect(transport.texts.some(([, text]) => text === answer)).toBe(true), SEND_WAIT);
    const [, , waMessageId] = transport.texts.find(([, text]) => text === answer)!;
    ingest(echoMsg(DM_JID, waMessageId, answer));
    await drainIngest();
    await vi.waitFor(() => expect(answerOp(seq)?.status).toBe('echoed'), SEND_WAIT);
    return { seq, session };
  }

  /** The supervisor's kill as the runtime receives it: the session manager's crash report. */
  function reportCrash(session: SessionDouble, crash: Record<string, unknown>): void {
    const owner = (runtime as unknown as {
      sessionOwnership: { get: (key: string) => { managerId: string; generation: number } | undefined };
    }).sessionOwnership.get(DM_JID);
    if (!owner) throw new Error('no owner for the chat');
    const sessionId = session.getStatus().sessionId;
    session.killProvider();
    session.ctorOpts.onCrash!({
      exitCode: null,
      signal: 'SIGKILL',
      sessionId,
      dbRowId: session.getDbRowId(),
      provider: 'claude-cli',
      generationIdentity: { managerId: owner.managerId, generation: owner.generation },
      ...crash,
    });
  }

  /** Stop the service and boot a new one over the same database. */
  async function restartService(
    previous: AgentRuntime,
    beforeBoot: () => void = () => {},
  ): Promise<{ agent: AgentRuntime; booted: SessionDouble[] }> {
    await previous.shutdown();
    beforeBoot();
    runtime = undefined;
    await prepareRuntimeHome();
    const bootIndex = sessionDoubles.length;
    mockConfig.proactiveResumeOnStartup = true;
    const agent = makeRuntime();
    await agent.start();
    // Proactive resume waits 1 s after the spawn before its turns.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    return { agent, booted: sessionDoubles.slice(bootIndex) };
  }

  it('a restart after the kill and its respawn resumes the session with no turn; the next request is delivered and releases the hold', async () => {
    const first = makeRuntime();
    const { session } = await deliveredExchange(makeIngest(first), 'wamid-f7-1', 'start the export', 'Export started.');
    const sessionId = session.getStatus().sessionId!;
    const turnsBeforeKill = session.turnsSent.length;

    reportCrash(session, { terminationReason: 'stalled_operation' });

    expect(checkpoint(), 'the crash orphans the checkpoint; the hold is on it').toMatchObject({
      session_id: sessionId,
      session_status: 'orphaned',
      watchdog: { stalledOperationResumeHold: { sessionId } },
    });

    await waitForRespawn(session, sessionId);
    expect(checkpoint(), 'the respawn reactivates the checkpoint and keeps the hold').toMatchObject({
      session_status: 'active',
      watchdog: { stalledOperationResumeHold: { sessionId } },
    });
    expect(session.turnsSent.length, 'the respawn sends no turn').toBe(turnsBeforeKill);

    const { agent, booted } = await restartService(first);
    const resumed = booted.find((s) => s.ctorOpts.chatJid === DM_JID);
    expect(resumed, 'the session is resumed, so its context is kept').toBeDefined();
    expect(resumed!.spawnSession).toHaveBeenCalledWith(sessionId);
    expect(sentTexts(resumed!), 'no context or continuation turn').toEqual([]);

    const next = await deliveredExchange(makeIngest(agent), 'wamid-f7-2', 'try the export again', 'Export finished.');
    expect(next.session).toBe(resumed);
    expect(sentTexts(resumed!).filter((t) => t.includes(RESTART_CONTINUATION))).toEqual([]);
    expect(inbound(next.seq)).toEqual({ processing_status: 'complete', terminal_reason: 'response_echoed' });
    expect(checkpoint().watchdog).not.toHaveProperty('stalledOperationResumeHold');

    // Released: a later restart continues as for any session.
    const later = await restartService(agent);
    const resumedLater = later.booted.find((s) => s.ctorOpts.chatJid === DM_JID);
    await vi.waitFor(
      () => expect(sentTexts(resumedLater!).some((t) => t.includes(RESTART_CONTINUATION))).toBe(true),
      SEND_WAIT,
    );
  });

  it('when the hold cannot be saved, a restart sends no automatic turn and the next request is delivered', async () => {
    const first = makeRuntime();
    const { session } = await deliveredExchange(makeIngest(first), 'wamid-f7-w1', 'start the export', 'Export started.');
    const sessionId = session.getStatus().sessionId!;
    const upsert = engine.upsertSessionCheckpoint.bind(engine);
    const holdWrites = vi.spyOn(engine, 'upsertSessionCheckpoint').mockImplementation((key, fields) => {
      if (typeof fields.watchdogState === 'string' && fields.watchdogState.includes('stalledOperationResumeHold')) {
        throw new Error('SQLITE_FULL: database or disk is full');
      }
      upsert(key, fields);
    });

    reportCrash(session, { terminationReason: 'stalled_operation' });
    await waitForRespawn(session, sessionId);

    expect(holdWrites).toHaveBeenCalled();
    expect(checkpoint(), 'the respawn reactivated it; the unsaved hold withdraws it again').toMatchObject({
      session_id: sessionId,
      session_status: 'orphaned',
    });
    expect(checkpoint().watchdog).not.toHaveProperty('stalledOperationResumeHold');
    expect(engine.getResumableCheckpoints().map((c) => c.conversation_key)).not.toContain(DM_KEY);

    // The write still fails at shutdown, after the session suspends its checkpoint.
    const { agent, booted } = await restartService(first, () => {
      expect(engine.getResumableCheckpoints().map((c) => c.conversation_key)).not.toContain(DM_KEY);
      holdWrites.mockRestore();
    });
    expect(booted.flatMap(sentTexts), 'no automatic turn at boot').toEqual([]);

    const next = await deliveredExchange(makeIngest(agent), 'wamid-f7-w2', 'try the export again', 'Export finished.');
    expect(sentTexts(next.session).filter((t) => t.includes(RESTART_CONTINUATION))).toEqual([]);
    expect(inbound(next.seq)).toEqual({ processing_status: 'complete', terminal_reason: 'response_echoed' });
  });

  it('control: after an ordinary crash and its respawn, a restart sends its continuation and nothing is held', async () => {
    const first = makeRuntime();
    const { session } = await deliveredExchange(makeIngest(first), 'wamid-f7-c1', 'start the export', 'Export started.');
    const sessionId = session.getStatus().sessionId!;

    reportCrash(session, { exitCode: 1, signal: null });
    await waitForRespawn(session, sessionId);
    if (session.turnInFlight) session.emit({ type: 'result', text: 'NO_REPLY' });

    expect(checkpoint()).toMatchObject({ session_id: sessionId, session_status: 'active' });
    expect(checkpoint().watchdog).not.toHaveProperty('stalledOperationResumeHold');

    const { booted } = await restartService(first);
    const resumed = booted.find((s) => s.ctorOpts.chatJid === DM_JID);
    expect(resumed!.spawnSession).toHaveBeenCalledWith(sessionId);
    await vi.waitFor(
      () => expect(sentTexts(resumed!).some((t) => t.includes(RESTART_CONTINUATION))).toBe(true),
      SEND_WAIT,
    );
  });
});
