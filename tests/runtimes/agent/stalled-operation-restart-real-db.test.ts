// F7 across a real service restart. A stalled-operation kill tells the user
// to send the message again and the killed request is finalized as failed, so
// a restart must not continue that work on the agent's own initiative. The
// kill parks the session: the hold on its checkpoint and the checkpoint out of
// proactive resume, both in SQLite, so neither this build nor a rollback build
// that ignores the hold resumes it at boot. These cases drive the kill, the
// shutdown or a hard stop, the restart and the user's next request end to end
// and read the stored rows.
//
// Harness: the late-echo real-database harness
// (late-echo-completed-identity-runtime.test.ts): REAL AgentRuntime + REAL
// OutboundQueue + REAL SQLite durability + REAL ingest. The database is a
// file: a restart closes it and the next service opens it again, so only what
// reached the file survives. Lazy adoption reads the saved session rows for
// real (session-db getResumableSessionForChat and markOrphaned stay real). A reply counts as
// delivered only when its outbound op is `echoed` after the transport's echo
// came back through ingest. The provider session is a double; a kill is the
// double reporting a crash through the runtime's own onCrash wiring.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Messenger, IncomingMessage } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import { resetLoggerMock, type SingletonLoggerMock } from '../../helpers/logger-mock.ts';

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
    // Each fresh spawn (the first one, a /new reset) starts a distinct provider session.
    let freshSpawns = 0;
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
        freshSpawns += 1;
        sessionId = `sess-${conversationKey}-${pid}-${freshSpawns}`;
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

// Only the runtime's own logger is captured: proactive resume reports the
// stalled-operation hold on it. Every other component keeps the no-op logger
// loggerMock() hands out.
const runtimeLogger = vi.hoisted(() => ({ log: undefined as unknown as SingletonLoggerMock }));

vi.mock('../../../src/logger.ts', async () => {
  const { componentLoggerMock, loggerMock } = await import('../../helpers/logger-mock.ts');
  const mock = componentLoggerMock('agent-runtime', () => loggerMock().createChildLogger());
  runtimeLogger.log = mock.log;
  return { createChildLogger: mock.createChildLogger };
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

vi.mock('../../../src/runtimes/agent/session-db.ts', async (importOriginal) => ({
  // Real: getResumableSessionForChat (lazy adoption after a restart) and
  // markOrphaned (a withheld respawn keeps the session for the next request).
  ...(await importOriginal<Record<string, unknown>>()),
  ensureAgentSchema: vi.fn(),
  createSession: vi.fn(() => 1),
  accumulateSessionTokens: vi.fn(),
  incrementMessageCount: vi.fn(),
  updateSessionId: vi.fn(),
  updateSessionStatus: vi.fn(),
  getActiveSession: vi.fn(() => null),
  backfillWorkspaceKeys: vi.fn(),
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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import { createIngestHandler } from '../../../src/core/ingest.ts';
import { toConversationKey } from '../../../src/core/conversation-key.ts';
import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { CHECKPOINT_NOT_RESTORED_NOTICE } from '../../../src/runtimes/agent/checkpoint-adoption.ts';
import { StalledOperationHolds } from '../../../src/runtimes/agent/stalled-operation-holds.ts';
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
  let dbDir: string;
  let dbPath: string;
  let db: Database;
  let engine: DurabilityEngine;
  let runtime: AgentRuntime | undefined;
  let transport: ReturnType<typeof makeRecordingTransport>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDoubles();
    mockConfig.proactiveResumeOnStartup = false;
    transport = makeRecordingTransport();
    dbDir = mkdtempSync(join(tmpdir(), 'whatsoup-f7-restart-db-'));
    dbPath = join(dbDir, 'whatsoup.db');
    db = new Database(dbPath);
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
      rmSync(dbDir, { recursive: true, force: true });
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

  function agentRow(rowId: number): { status: string; session_id: string | null } {
    return db.raw.prepare('SELECT status, session_id FROM agent_sessions WHERE id = ?').get(rowId) as
      { status: string; session_id: string | null };
  }

  function resumableKeys(): string[] {
    return engine.getResumableCheckpoints().map((c) => c.conversation_key);
  }

  /** The kill scheduled no automatic respawn: no timer, and the chat waits recoverable_dead. */
  function expectRespawnWithheld(agent: AgentRuntime): void {
    const state = agent as unknown as {
      pendingRespawnTimers: Set<unknown>;
      sessionOwnership: { get: (key: string) => { state: string; respawnTimer?: unknown } | undefined };
    };
    expect(state.pendingRespawnTimers.size, 'no respawn timer').toBe(0);
    expect(state.sessionOwnership.get(DM_JID)?.state).toBe('recoverable_dead');
    expect(state.sessionOwnership.get(DM_JID)?.respawnTimer ?? null).toBeNull();
  }

  /** Past the longest first-attempt respawn backoff (2 s base, +25% jitter). */
  async function waitPastRespawnBackoff(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }

  function terminalCount(seq: number): number {
    return (db.raw.prepare('SELECT COUNT(*) AS n FROM turn_terminal_records WHERE inbound_seq = ?').get(seq) as { n: number }).n;
  }

  type RuntimeTurnState = {
    chatSessions: Map<string, unknown>;
    perChatTurnQueues: Map<string, { isProcessing: boolean; activeTurn: unknown; pending: number }>;
  };

  /** The chat's turn queue has returned from its last turn: nothing active, processing or pending. */
  function expectTurnQueueIdle(agent: AgentRuntime): void {
    const queue = (agent as unknown as RuntimeTurnState).perChatTurnQueues.get(DM_JID);
    expect(queue, 'the chat keeps its turn queue').toBeDefined();
    expect(queue!.isProcessing).toBe(false);
    expect(queue!.activeTurn).toBeNull();
    expect(queue!.pending).toBe(0);
  }

  /** Proactive resume took the hold branch for this session, which returns before any turn. */
  async function waitForResumeHeld(sessionId: string): Promise<void> {
    await vi.waitFor(() => expect(runtimeLogger.log.info).toHaveBeenCalledWith(
      { chatJid: DM_JID, sessionId },
      'proactive resume after a stalled-operation kill — no context or continuation turn sent',
    ), SEND_WAIT);
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

  /**
   * The supervisor's kill as the runtime receives it: the session manager's
   * crash report. `afterExit` runs between the provider exit and the report.
   */
  function reportCrash(
    session: SessionDouble,
    crash: Record<string, unknown>,
    afterExit: () => void = () => {},
  ): void {
    const owner = (runtime as unknown as {
      sessionOwnership: { get: (key: string) => { managerId: string; generation: number } | undefined };
    }).sessionOwnership.get(DM_JID);
    if (!owner) throw new Error('no owner for the chat');
    const sessionId = session.getStatus().sessionId;
    session.killProvider();
    afterExit();
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

  /**
   * Stop the service, close the database file, and boot a new service on
   * `path`: the service's own file, or a hard-stop snapshot. `afterOpen` reads
   * the file the boot will see, before the boot. No wait: start() decides
   * every proactive resume and calls its spawn before it returns.
   */
  async function bootService(
    previous: AgentRuntime,
    opts: { path?: string; beforeBoot?: () => void; afterOpen?: () => void } = {},
  ): Promise<{ agent: AgentRuntime; booted: SessionDouble[] }> {
    await previous.shutdown();
    opts.beforeBoot?.();
    runtime = undefined;
    db.close();
    db = new Database(opts.path ?? dbPath);
    db.open();
    engine = new DurabilityEngine(db);
    opts.afterOpen?.();
    await prepareRuntimeHome();
    const bootIndex = sessionDoubles.length;
    // A runtime log line read after this boot comes from this boot.
    resetLoggerMock(runtimeLogger.log);
    mockConfig.proactiveResumeOnStartup = true;
    const agent = makeRuntime();
    await agent.start();
    return { agent, booted: sessionDoubles.slice(bootIndex) };
  }

  /** bootService on the service's own file, then past the 1 s proactive resume wait before its turns. */
  async function restartService(
    previous: AgentRuntime,
    beforeBoot: () => void = () => {},
  ): Promise<{ agent: AgentRuntime; booted: SessionDouble[] }> {
    const booted = await bootService(previous, { beforeBoot });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    return booted;
  }

  /**
   * What a hard stop (SIGKILL, crash) leaves: the committed rows of the
   * database file at this moment, before any shutdown write. Booting on the
   * copy is the restart after that stop.
   */
  function hardStopSnapshot(): string {
    const path = join(dbDir, `hard-stop-${sessionDoubles.length}.db`);
    db.raw.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
    return path;
  }

  /**
   * The rollback binary: both predecessor builds (a804bb2a, 44d38619a) have no
   * stalled-operation hold, so their proactive resume continues any checkpoint
   * getResumableCheckpoints returns (the same query in all three builds). This
   * build without its hold check is that behaviour.
   */
  function ignoreTheHold(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(StalledOperationHolds.prototype, 'holdsProactiveResume').mockReturnValue(false);
  }

  /** The chat's checkpoint and agent row as a park leaves them: the hold on an orphaned checkpoint, the row kept for lazy resume. */
  function expectParked(sessionId: string, rowId: number): void {
    expect(checkpoint()).toMatchObject({
      session_id: sessionId,
      session_status: 'orphaned',
      watchdog: { stalledOperationResumeHold: { sessionId } },
    });
    expect(resumableKeys(), 'out of proactive resume in every build').not.toContain(DM_KEY);
    expect(agentRow(rowId), 'the session row is kept for the next request').toEqual({ status: 'orphaned', session_id: sessionId });
  }

  it('the kill parks the session with no respawn; the next request resumes the same session in place and releases the hold', async () => {
    const first = makeRuntime();
    const ingest = makeIngest(first);
    const { session } = await deliveredExchange(ingest, 'wamid-f7-1', 'start the export', 'Export started.');
    const sessionId = session.getStatus().sessionId!;
    const rowId = session.getDbRowId()!;
    const turnsBeforeKill = session.turnsSent.length;

    reportCrash(session, { terminationReason: 'stalled_operation' });

    expectParked(sessionId, rowId);
    expectRespawnWithheld(first);
    expect(session.spawnSession, 'only the first spawn; nothing reactivates the parked checkpoint').toHaveBeenCalledTimes(1);

    const next = await deliveredExchange(ingest, 'wamid-f7-2', 'try the export again', 'Export finished.');
    expect(next.session).toBe(session);
    expect(session.spawnSession, 'the same provider session, so its context is kept').toHaveBeenLastCalledWith(sessionId, rowId);
    const sentAfterKill = sentTexts(session).slice(turnsBeforeKill);
    expect(sentAfterKill, 'only the request; no context or continuation turn').toHaveLength(1);
    expect(sentAfterKill[0]).toContain('try the export again');
    expect(inbound(next.seq)).toEqual({ processing_status: 'complete', terminal_reason: 'response_echoed' });
    expect(checkpoint()).toMatchObject({ session_id: sessionId, session_status: 'active' });
    expect(checkpoint().watchdog).not.toHaveProperty('stalledOperationResumeHold');

    // Released: a later restart continues as for any session.
    const later = await bootService(first);
    const resumedLater = later.booted.find((s) => s.ctorOpts.chatJid === DM_JID);
    expect(resumedLater?.spawnSession).toHaveBeenCalledWith(sessionId);
    await vi.waitFor(
      () => expect(sentTexts(resumedLater!).some((t) => t.includes(RESTART_CONTINUATION))).toBe(true),
      SEND_WAIT,
    );
  });

  it('a hard stop after the kill: a rollback build that ignores the hold resumes nothing at boot, and the next request resumes the same session', async () => {
    const first = makeRuntime();
    const { session } = await deliveredExchange(makeIngest(first), 'wamid-f7-h1', 'start the export', 'Export started.');
    const sessionId = session.getStatus().sessionId!;
    const rowId = session.getDbRowId()!;
    reportCrash(session, { terminationReason: 'stalled_operation' });
    expectRespawnWithheld(first);
    const hardStop = hardStopSnapshot();

    const holdReads = ignoreTheHold();
    try {
      const { agent, booted } = await bootService(first, {
        path: hardStop,
        afterOpen: () => expectParked(sessionId, rowId),
      });
      expect(booted.filter((s) => s.ctorOpts.chatJid === DM_JID), 'no session resumed at boot, so no turn can be sent').toEqual([]);
      expect(holdReads, 'nothing reached the hold check: the park alone kept the session out').not.toHaveBeenCalled();

      const next = await deliveredExchange(makeIngest(agent), 'wamid-f7-h2', 'try the export again', 'Export finished.');
      expect(next.session.spawnSession, 'lazy adoption resumes the parked session').toHaveBeenCalledWith(sessionId, rowId);
      const sent = sentTexts(next.session);
      expect(sent, 'only the request; no context or continuation turn').toHaveLength(1);
      expect(sent[0]).toContain('try the export again');
      expect(transport.texts.map(([, text]) => text), 'no fresh-start notice').not.toContain(CHECKPOINT_NOT_RESTORED_NOTICE);
      expect(inbound(next.seq)).toEqual({ processing_status: 'complete', terminal_reason: 'response_echoed' });
    } finally {
      holdReads.mockRestore();
    }
  });

  it('control: a rollback build that ignores the hold continues a checkpoint that is only held, not parked', async () => {
    const first = makeRuntime();
    const { session } = await deliveredExchange(makeIngest(first), 'wamid-f7-hc1', 'start the export', 'Export started.');
    const sessionId = session.getStatus().sessionId!;
    reportCrash(session, { terminationReason: 'stalled_operation' });
    // The state an automatic respawn left before the park: the hold on a reactivated checkpoint.
    db.raw.prepare("UPDATE session_checkpoints SET session_status = 'active' WHERE conversation_key = ?").run(DM_KEY);
    const hardStop = hardStopSnapshot();

    const holdReads = ignoreTheHold();
    try {
      const { booted } = await bootService(first, {
        path: hardStop,
        afterOpen: () => expect(checkpoint()).toMatchObject({
          session_status: 'active',
          watchdog: { stalledOperationResumeHold: { sessionId } },
        }),
      });
      const resumed = booted.find((s) => s.ctorOpts.chatJid === DM_JID);
      expect(resumed?.spawnSession).toHaveBeenCalledWith(sessionId);
      await vi.waitFor(
        () => expect(sentTexts(resumed!).some((t) => t.includes(RESTART_CONTINUATION))).toBe(true),
        SEND_WAIT,
      );
    } finally {
      holdReads.mockRestore();
    }
  });

  /**
   * The next request does not reach the provider: `refused` before the provider
   * boundary (the canary refusal), `write_failed` after it (the stdin write fails).
   */
  async function undeliveredRequest(
    ingest: (msg: IncomingMessage) => void,
    session: SessionDouble,
    messageId: string,
    content: string,
    mode: 'refused' | 'write_failed',
  ): Promise<void> {
    const attempts = session.sendTurn.mock.calls.length;
    const refusal = vi.fn(async () => {
      throw new Error('provider MCP canary proof unavailable');
    });
    if (mode === 'refused') {
      Object.assign(session, { sendTurnAtProviderBoundary: refusal });
    } else {
      session.sendTurn.mockImplementationOnce((input: unknown) => {
        session.turnsSent.push(input);
        return Promise.reject(new Error('STDIN_WRITE_TIMEOUT: provider stdin write timed out'));
      });
    }
    ingest(customerMsg(DM_JID, messageId, content));
    await drainIngest();
    await vi.waitFor(() => {
      if (mode === 'refused') expect(refusal).toHaveBeenCalled();
      else expect(session.sendTurn.mock.calls.length).toBeGreaterThan(attempts);
    }, SEND_WAIT);
    // Done with the request: it has a terminal record (refused finalizes as a
    // pre-dispatch rejection, write_failed as a failed processor turn; neither
    // has an answer to wait for) and the turn queue has returned from it, so
    // no later step of this turn can reach the provider boundary.
    const seq = inboundSeqByMessageId(messageId);
    await vi.waitFor(() => {
      expect(terminalCount(seq)).toBe(1);
      expectTurnQueueIdle(runtime!);
    }, SEND_WAIT);
    if (mode === 'refused') delete (session as { sendTurnAtProviderBoundary?: unknown }).sendTurnAtProviderBoundary;
  }

  for (const mode of ['refused', 'write_failed'] as const) {
    it(`a ${mode === 'refused' ? 'refused' : 'failed'} next request keeps the hold; a restart still sends no context or continuation turn`, async () => {
      const first = makeRuntime();
      const ingest = makeIngest(first);
      const { session } = await deliveredExchange(ingest, `wamid-f7-${mode}-1`, 'start the export', 'Export started.');
      const sessionId = session.getStatus().sessionId!;
      reportCrash(session, { terminationReason: 'stalled_operation' });

      // The request resumes the parked session in place and is not delivered.
      await undeliveredRequest(ingest, session, `wamid-f7-${mode}-2`, 'try the export again', mode);
      expect(checkpoint().watchdog, 'an undelivered request does not release the hold').toMatchObject({
        stalledOperationResumeHold: { sessionId },
      });

      const { booted } = await restartService(first);
      const resumed = booted.find((s) => s.ctorOpts.chatJid === DM_JID);
      expect(resumed, 'the held session is resumed at boot').toBeDefined();
      await waitForResumeHeld(sessionId);
      const sent = sentTexts(resumed!);
      expect(
        sent.filter((t) => t.includes(RESTART_CONTINUATION) || t.includes('[Recent chat context')),
        'no context or continuation turn',
      ).toEqual([]);
      expect(checkpoint().watchdog, 'still held after the restart').toMatchObject({
        stalledOperationResumeHold: { sessionId },
      });
    });
  }

  it('a next request cancelled by /stop before the provider boundary keeps the hold; a restart still sends no context or continuation turn', async () => {
    const first = makeRuntime();
    const ingest = makeIngest(first);
    const { session } = await deliveredExchange(ingest, 'wamid-f7-cancel-1', 'start the export', 'Export started.');
    const sessionId = session.getStatus().sessionId!;
    reportCrash(session, { terminationReason: 'stalled_operation' });

    // The next request waits at the provider boundary until /stop has cancelled it.
    let openBoundary!: () => void;
    const boundaryOpen = new Promise<void>((resolve) => { openBoundary = resolve; });
    let readyError: unknown;
    const boundary = vi.fn(async (input: unknown, onReady?: () => void) => {
      await boundaryOpen;
      try {
        onReady?.();
      } catch (err) {
        readyError = err;
        throw err;
      }
      session.turnsSent.push(input);
    });
    Object.assign(session, { sendTurnAtProviderBoundary: boundary });
    ingest(customerMsg(DM_JID, 'wamid-f7-cancel-2', 'try the export again'));
    await vi.waitFor(() => expect(boundary).toHaveBeenCalled(), SEND_WAIT);
    const seq = inboundSeqByMessageId('wamid-f7-cancel-2');

    ingest(customerMsg(DM_JID, 'wamid-f7-cancel-stop', '/stop'));
    await vi.waitFor(() => expect(inbound(seq).processing_status).toBe('failed'), SEND_WAIT);
    openBoundary();
    await drainIngest();
    await vi.waitFor(() => expect(readyError).toBeDefined(), SEND_WAIT);
    // Done with the cancelled request: /stop retires the chat's turn queue only
    // after the queue has returned from the cancelled turn
    // (retirePerChatTurnQueueAfterKill awaits its quiescence), then drops the session.
    await vi.waitFor(() => {
      const state = first as unknown as RuntimeTurnState;
      expect(state.perChatTurnQueues.has(DM_JID)).toBe(false);
      expect(state.chatSessions.has(DM_JID)).toBe(false);
    }, SEND_WAIT);
    delete (session as { sendTurnAtProviderBoundary?: unknown }).sendTurnAtProviderBoundary;

    expect(String(readyError), 'the cancellation stops the dispatch at the provider boundary')
      .toContain('TURN_RECOVERY_DISPATCH_TARGET_SUPERSEDED');
    expect(sentTexts(session).filter((t) => t.includes('try the export again')), 'the provider never received it').toEqual([]);
    expect(checkpoint().watchdog, 'a cancelled request does not release the hold').toMatchObject({
      stalledOperationResumeHold: { sessionId },
    });

    // /stop shut the session down as ended, so its checkpoint is not resumable
    // and the boot creates no session for this chat (start() decides every
    // proactive resume before it returns). No session means no turn can be sent.
    const { booted } = await restartService(first, () => {
      expect(resumableKeys(), '/stop ended the session; the boot has nothing to resume').not.toContain(DM_KEY);
    });
    const bootedForChat = booted.filter((s) => s.ctorOpts.chatJid === DM_JID);
    expect(bootedForChat, 'no session resumed for the chat at boot').toEqual([]);
    const sent = bootedForChat.flatMap(sentTexts);
    expect(
      sent.filter((t) => t.includes(RESTART_CONTINUATION) || t.includes('[Recent chat context')),
      'no context or continuation turn',
    ).toEqual([]);
    expect(checkpoint().watchdog, 'still held after the restart').toMatchObject({
      stalledOperationResumeHold: { sessionId },
    });
  });

  function failHoldWrites(): ReturnType<typeof vi.spyOn> {
    const upsert = engine.upsertSessionCheckpoint.bind(engine);
    return vi.spyOn(engine, 'upsertSessionCheckpoint').mockImplementation((key, fields) => {
      if (typeof fields.watchdogState === 'string' && fields.watchdogState.includes('stalledOperationResumeHold')) {
        throw new Error('SQLITE_FULL: database or disk is full');
      }
      upsert(key, fields);
    });
  }

  it('when the hold cannot be saved, no respawn reactivates the session; the next request resumes the same session in place', async () => {
    const first = makeRuntime();
    const ingest = makeIngest(first);
    const { session } = await deliveredExchange(ingest, 'wamid-f7-w1', 'start the export', 'Export started.');
    const sessionId = session.getStatus().sessionId!;
    const rowId = session.getDbRowId()!;
    const turnsBeforeKill = session.turnsSent.length;
    const holdWrites = failHoldWrites();

    reportCrash(session, { terminationReason: 'stalled_operation' });

    expect(holdWrites).toHaveBeenCalled();
    expectRespawnWithheld(first);
    expect(checkpoint(), 'withdrawn, and no respawn makes it resumable again').toMatchObject({
      session_id: sessionId,
      session_status: 'orphaned',
    });
    expect(checkpoint().watchdog).not.toHaveProperty('stalledOperationResumeHold');
    expect(resumableKeys()).not.toContain(DM_KEY);
    expect(agentRow(rowId), 'the session row is kept for the next request').toEqual({ status: 'orphaned', session_id: sessionId });
    await waitPastRespawnBackoff();
    expect(session.spawnSession, 'only the first spawn; no automatic resume').toHaveBeenCalledTimes(1);
    holdWrites.mockRestore();

    const next = await deliveredExchange(ingest, 'wamid-f7-w2', 'try the export again', 'Export finished.');
    expect(next.session).toBe(session);
    expect(session.spawnSession, 'the same provider session, so its context is kept').toHaveBeenLastCalledWith(sessionId, rowId);
    expect(sentTexts(session).slice(turnsBeforeKill), 'only the request; no context or continuation turn').toHaveLength(1);
    expect(inbound(next.seq)).toEqual({ processing_status: 'complete', terminal_reason: 'response_echoed' });
  });

  it('when both protective writes fail, no respawn runs, a restart sends nothing, and the next request resumes the same session', async () => {
    const first = makeRuntime();
    const { session } = await deliveredExchange(makeIngest(first), 'wamid-f7-b1', 'start the export', 'Export started.');
    const sessionId = session.getStatus().sessionId!;
    const rowId = session.getDbRowId()!;
    const turnsBeforeKill = session.turnsSent.length;
    const holdWrites = failHoldWrites();
    const withdrawals = vi.spyOn(engine, 'updateExactSessionCheckpointStatus').mockImplementation(() => {
      throw new Error('SQLITE_FULL: database or disk is full');
    });

    reportCrash(session, { terminationReason: 'stalled_operation' });

    expect(holdWrites).toHaveBeenCalled();
    expect(withdrawals).toHaveBeenCalled();
    expectRespawnWithheld(first);
    await waitPastRespawnBackoff();
    expect(session.spawnSession, 'no automatic reactivation').toHaveBeenCalledTimes(1);
    expect(session.turnsSent).toHaveLength(turnsBeforeKill);
    expect(checkpoint(), "only the crash's own write orphaned it").toMatchObject({
      session_id: sessionId,
      session_status: 'orphaned',
    });
    expect(checkpoint().watchdog).not.toHaveProperty('stalledOperationResumeHold');

    // Both writes still fail at shutdown, and the checkpoint stays out of proactive resume.
    const { agent, booted } = await restartService(first, () => {
      expect(resumableKeys()).not.toContain(DM_KEY);
      holdWrites.mockRestore();
      withdrawals.mockRestore();
    });
    expect(resumableKeys()).not.toContain(DM_KEY);
    expect(booted, 'no session resumed at boot').toEqual([]);
    expect(transport.texts.map(([, text]) => text)).not.toContain(CHECKPOINT_NOT_RESTORED_NOTICE);

    const next = await deliveredExchange(makeIngest(agent), 'wamid-f7-b2', 'try the export again', 'Export finished.');
    expect(next.session.spawnSession, 'lazy adoption resumes the kept session').toHaveBeenCalledWith(sessionId, rowId);
    expect(sentTexts(next.session), 'only the request; no context or continuation turn').toHaveLength(1);
    expect(transport.texts.map(([, text]) => text), 'no fresh-start notice').not.toContain(CHECKPOINT_NOT_RESTORED_NOTICE);
    expect(inbound(next.seq)).toEqual({ processing_status: 'complete', terminal_reason: 'response_echoed' });
  });

  it('when the park write fails, no respawn runs, the hold covers this build, and the shutdown repeats the park', async () => {
    const first = makeRuntime();
    const { session } = await deliveredExchange(makeIngest(first), 'wamid-f7-p1', 'start the export', 'Export started.');
    const sessionId = session.getStatus().sessionId!;
    const rowId = session.getDbRowId()!;
    const parkWrites = vi.spyOn(engine, 'updateExactSessionCheckpointStatus').mockImplementationOnce(() => {
      throw new Error('SQLITE_FULL: database or disk is full');
    });

    // The crash's own orphan write did not land, so the park is all that can
    // take the checkpoint out of proactive resume, and its write fails.
    reportCrash(session, { terminationReason: 'stalled_operation' }, () => {
      db.raw.prepare("UPDATE session_checkpoints SET session_status = 'active' WHERE conversation_key = ?").run(DM_KEY);
    });

    expect(parkWrites).toHaveBeenCalled();
    expectRespawnWithheld(first);
    expect(session.spawnSession, 'no automatic reactivation').toHaveBeenCalledTimes(1);
    expect(checkpoint(), 'not parked; the hold is saved').toMatchObject({
      session_id: sessionId,
      session_status: 'active',
      watchdog: { stalledOperationResumeHold: { sessionId } },
    });
    expect(resumableKeys()).toContain(DM_KEY);

    // The chat stayed unverified, so the shutdown parks it before the next boot.
    const { agent, booted } = await bootService(first, {
      afterOpen: () => expectParked(sessionId, rowId),
    });
    expect(booted.filter((s) => s.ctorOpts.chatJid === DM_JID), 'no session resumed at boot').toEqual([]);

    const next = await deliveredExchange(makeIngest(agent), 'wamid-f7-p2', 'try the export again', 'Export finished.');
    expect(next.session.spawnSession, 'lazy adoption resumes the parked session').toHaveBeenCalledWith(sessionId, rowId);
    expect(sentTexts(next.session), 'only the request; no context or continuation turn').toHaveLength(1);
    expect(inbound(next.seq)).toEqual({ processing_status: 'complete', terminal_reason: 'response_echoed' });
  });

  it('a /new after the kill starts a fresh session and never revives the parked one, in this process or after a hard stop', async () => {
    const first = makeRuntime();
    const ingest = makeIngest(first);
    const { session } = await deliveredExchange(ingest, 'wamid-f7-i1', 'start the export', 'Export started.');
    const parkedSessionId = session.getStatus().sessionId!;
    const parkedRowId = session.getDbRowId()!;
    reportCrash(session, { terminationReason: 'stalled_operation' });
    expectRespawnWithheld(first);
    expectParked(parkedSessionId, parkedRowId);

    ingest(customerMsg(DM_JID, 'wamid-f7-i-new', '/new'));
    await drainIngest();
    const state = first as unknown as {
      chatSessions: Map<string, SessionDouble>;
      sessionOwnership: { get: (key: string) => { state: string } | undefined };
    };
    await vi.waitFor(() => {
      expect(state.chatSessions.get(DM_JID)?.getStatus().active).toBe(true);
      expect(state.sessionOwnership.get(DM_JID)?.state).toBe('active');
    }, SEND_WAIT);
    const fresh = state.chatSessions.get(DM_JID)!;
    const freshSessionId = fresh.getStatus().sessionId!;
    expect(freshSessionId, '/new started another provider session').not.toBe(parkedSessionId);

    const next = await deliveredExchange(ingest, 'wamid-f7-i2', 'start a new report', 'Report started.');
    expect(next.session).toBe(fresh);
    expect(next.session.getStatus().sessionId, 'the request ran on the fresh session').toBe(freshSessionId);
    const resumesOfParked = sessionDoubles.flatMap((s) => s.spawnSession.mock.calls)
      .filter((call) => call[0] === parkedSessionId);
    expect(resumesOfParked, 'nothing resumed the parked session').toEqual([]);
    expect(agentRow(parkedRowId), 'the parked row is untouched').toEqual({ status: 'orphaned', session_id: parkedSessionId });
    expect(checkpoint()).toMatchObject({ session_id: freshSessionId, session_status: 'active' });

    const hardStop = hardStopSnapshot();
    const { booted } = await bootService(first, { path: hardStop });
    const bootedForChat = booted.filter((s) => s.ctorOpts.chatJid === DM_JID);
    expect(bootedForChat.flatMap((s) => s.spawnSession.mock.calls), 'the boot resumes only the fresh session')
      .toEqual([[freshSessionId]]);
    expect(agentRow(parkedRowId)).toEqual({ status: 'orphaned', session_id: parkedSessionId });
  });

  it('when the checkpoint names another session at the kill, the shutdown retry does not withdraw the session /new started; its checkpoint stays resumable for the restart', async () => {
    const first = makeRuntime();
    const ingest = makeIngest(first);
    const { session } = await deliveredExchange(ingest, 'wamid-f7-n1', 'start the export', 'Export started.');
    const stalledSessionId = session.getStatus().sessionId!;

    // The checkpoint names another session when the kill is reported, so no
    // hold can be saved for the stopped session and the chat stays unverified.
    reportCrash(session, { terminationReason: 'stalled_operation' }, () => {
      db.raw.prepare('UPDATE session_checkpoints SET session_id = ? WHERE conversation_key = ?')
        .run('sess-f7-elsewhere', DM_KEY);
    });
    expectRespawnWithheld(first);
    expect(checkpoint().session_id).toBe('sess-f7-elsewhere');
    expect(checkpoint().watchdog).not.toHaveProperty('stalledOperationResumeHold');

    // /new starts a fresh provider session on the same chat.
    ingest(customerMsg(DM_JID, 'wamid-f7-n-new', '/new'));
    await drainIngest();
    const state = first as unknown as {
      chatSessions: Map<string, SessionDouble>;
      sessionOwnership: { get: (key: string) => { state: string } | undefined };
    };
    await vi.waitFor(() => {
      const current = state.chatSessions.get(DM_JID);
      expect(current?.spawnSession, 'the first spawn and the /new spawn; no resume').toHaveBeenCalledTimes(2);
      expect(current?.spawnSession).toHaveBeenLastCalledWith();
      expect(current?.getStatus().active).toBe(true);
      expect(state.sessionOwnership.get(DM_JID)?.state).toBe('active');
    }, SEND_WAIT);
    const freshSessionId = state.chatSessions.get(DM_JID)!.getStatus().sessionId!;
    expect(freshSessionId, '/new started another provider session').not.toBe(stalledSessionId);
    expect(checkpoint()).toMatchObject({ session_id: freshSessionId, session_status: 'active' });

    // Shutdown suspends the fresh session and then repeats the unverified
    // hold for the stopped session; that retry must leave the fresh
    // session's checkpoint resumable.
    await restartService(first, () => {
      expect(checkpoint(), 'the fresh session is suspended, not withdrawn').toMatchObject({
        session_id: freshSessionId,
        session_status: 'suspended',
      });
      expect(checkpoint().watchdog).not.toHaveProperty('stalledOperationResumeHold');
      expect(engine.getResumableCheckpoints().filter((cp) => cp.conversation_key === DM_KEY))
        .toEqual([expect.objectContaining({ session_id: freshSessionId })]);
    });
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
