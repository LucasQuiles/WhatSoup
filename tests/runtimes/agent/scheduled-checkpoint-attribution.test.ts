// #3570 — a scheduled agent job must not overwrite its chat's session checkpoint,
// and a chat whose context cannot be restored after a restart must be told.
//
// Non-sandbox per_chat runs a scheduled job on its own SessionManager, which
// persists under '<mapKey>::scheduled-agent-job'. The job's turn still carries
// the chat's ordinary conversation key, so turn finalization used to write the
// scheduled session's id/pid/status (and its completed identity) into the
// chat's own checkpoint row. After a restart the chat then tried to resume the
// scheduled session, the workspace-scoped lookup refused it, and the chat
// silently lost its context.
//
// Harness: REAL AgentRuntime + REAL RuntimeTurnCoordinator + REAL SQLite
// durability + REAL session classifier. Only the provider boundary is faked
// (same pattern as scheduled-turn-lifecycle.test.ts). The session double
// models the one real SessionManager write that matters here: on spawn it
// records its own session id, pid and 'active' status under its OWN
// persistence key (session.ts persistSessionLifecycleStart + the init-event
// upsert). Every double derives DISTINCT session ids and pids from that key,
// so an interactive and a scheduled manager can never satisfy an assertion
// with each other's values.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Messenger, IncomingMessage } from '../../../src/core/types.ts';
import type { StoredMessage } from '../../../src/core/messages.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import { toConversationKey } from '../../../src/core/conversation-key.ts';

// ─── Hoisted provider-boundary doubles ──────────────────────────────────────

const { sessionDoubles, queueDoubles, resetDoubles, makeSessionDouble, makeQueueDouble, harnessRef } = vi.hoisted(() => {
  type Harness = {
    createEchoedTerminalOp: (conversationKey: string, chatJid: string, sourceInboundSeq: number | undefined, text: string) => number;
    /** Mirrors SessionManager's own lifecycle write under its persistence key. */
    recordLifecycleStart: (persistenceKey: string, sessionId: string, pid: number) => void;
    /** When set, a resume attempt (spawnSession with an id) rejects like session-db's foreign-row refusal. */
    rejectResume: boolean;
  };
  const harnessRef: { current: Harness | null } = { current: null };
  type SessionCtorOpts = {
    chatJid: string;
    persistenceConversationKey?: string;
    onEvent: (event: AgentEvent) => void;
    onCrash?: (info: unknown) => void;
    onResumeFailed?: () => void;
    notifyUser?: (msg: string) => void;
  };

  let nextPid = 5100;
  const pidsByKey = new Map<string, number>();

  /** Distinct, key-derived identity: never shared between two managers. */
  function identityFor(persistenceKey: string): { sessionId: string; pid: number } {
    let pid = pidsByKey.get(persistenceKey);
    if (pid === undefined) {
      nextPid += 1;
      pid = nextPid;
      pidsByKey.set(persistenceKey, pid);
    }
    const bare = persistenceKey.replace(/@.*?(?=::|$)/, '');
    const sessionId = persistenceKey.endsWith('::scheduled-agent-job')
      ? `sess-scheduled-${bare.replace('::scheduled-agent-job', '')}`
      : `sess-interactive-${bare}`;
    return { sessionId, pid };
  }

  function makeSessionDouble(opts: SessionCtorOpts) {
    const persistenceKey = opts.persistenceConversationKey ?? opts.chatJid;
    const identity = identityFor(persistenceKey);
    let active = false;
    let sessionId: string | null = null;
    let pendingResolve: (() => void) | null = null;
    let pendingPromise: Promise<void> = Promise.resolve();
    const double = {
      ctorOpts: opts,
      persistenceKey,
      identity,
      turnsSent: [] as unknown[],
      get turnInFlight(): boolean {
        return pendingResolve !== null;
      },
      emit(event: AgentEvent): void {
        opts.onEvent(event);
      },
      spawnSession: vi.fn(async (resumeSessionId?: string) => {
        const harness = harnessRef.current;
        if (!harness) throw new Error('session double used before harness init');
        if (resumeSessionId !== undefined && harness.rejectResume) {
          throw new Error('Expected exactly one resumable agent row for the provider and conversation, found 0');
        }
        active = true;
        sessionId = resumeSessionId ?? identity.sessionId;
        harness.recordLifecycleStart(persistenceKey, sessionId, identity.pid);
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
        pid: active ? identity.pid : null,
        sessionId: active ? sessionId : null,
        startedAt: active ? new Date().toISOString() : null,
        messageCount: 0,
        lastMessageAt: null as string | null,
      })),
      shutdown: vi.fn(async () => {
        active = false;
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

  function makeQueueDouble(chatJid: string, conversationKey: string) {
    let currentInboundSeq: number | undefined;
    let answerOpIds: number[] = [];
    const double = {
      targetChatJid: chatJid,
      enqueueText: vi.fn(),
      getSenderToken: () => 'test-sender-token',
      enqueueStreamingText: vi.fn(),
      commitStreamingText: vi.fn(),
      discardPreToolAssistantText: vi.fn(),
      enqueueResultText: vi.fn((text: string) => {
        const harness = harnessRef.current;
        if (!harness) throw new Error('queue double used before harness init');
        answerOpIds.push(
          harness.createEchoedTerminalOp(conversationKey, chatJid, currentInboundSeq, text),
        );
      }),
      enqueueToolUpdate: vi.fn(),
      enqueueProgressUpdate: vi.fn(),
      indicateTyping: vi.fn(),
      flush: vi.fn(async () => {}),
      isPoisoned: vi.fn(() => false),
      shutdown: vi.fn(async () => {}),
      abortTurn: vi.fn(),
      updateDeliveryJid: vi.fn(),
      setInboundSeq: vi.fn((seq: number | undefined) => {
        currentInboundSeq = seq;
      }),
      markLastTerminal: vi.fn(),
      clearLastOpId: vi.fn(),
      beginTurnEvidence: vi.fn(),
      flushTurnEvidence: vi.fn(async (turnId: string) => {
        const flushed = answerOpIds;
        answerOpIds = [];
        return { turnId, answerOpIds: flushed, lifecycleOpIds: [], statusOpIds: [] };
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
    pidsByKey.clear();
  }

  return { sessionDoubles, queueDoubles, resetDoubles, makeSessionDouble, makeQueueDouble, harnessRef };
});

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    // Startup quarantines the scheduled row's identity-less checkpoint under
    // the configured provider, so the restart path needs one.
    agentProvider: 'claude-cli',
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set<string>(['15550001']),
    controlPeers: new Map<string, string>(),
    internalPeerJids: new Set<string>(),
    toolUpdateMode: 'full' as const,
    toolUpdateRedirectJid: null as string | null,
    textAggregateDelayMs: 2_000,
    stateRoot: `/tmp/whatsoup-test-state-sched-checkpoint-${process.pid}`,
    restartLoopGuard: { enabled: false, maxRestarts: 3, windowMs: 300_000 },
    startupNotifications: false,
    proactiveResumeOnStartup: false,
    mediaDir: `/tmp/whatsoup-test-media-sched-checkpoint-${process.pid}`,
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

vi.mock('../../../src/runtimes/agent/session.ts', () => ({
  // eslint-disable-next-line prefer-arrow-callback -- constructor mock requires function keyword; expires 2026-12-31
  SessionManager: vi.fn().mockImplementation(function (opts: {
    chatJid: string;
    persistenceConversationKey?: string;
    onEvent: (event: AgentEvent) => void;
    onCrash?: (info: unknown) => void;
    onResumeFailed?: () => void;
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
import { getRecentMessages } from '../../../src/core/messages.ts';
import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { classifyActiveSessions } from '../../../src/runtimes/agent/session-classifier.ts';
import type { StartupNotificationEvent } from '../../../src/core/startup-notification-controller.ts';
import { installFakePerChatMcpSocketManager } from './helpers/fake-per-chat-mcp-socket-manager.ts';
import { prepareRuntimeHome } from '../../helpers/runtime-home-fixture.ts';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const dmJid = '15550007001@s.whatsapp.net';
const dmKey = toConversationKey(dmJid);
const otherDmJid = '15550007002@s.whatsapp.net';
const otherDmKey = toConversationKey(otherDmJid);
const scheduledPersistenceKey = `${dmJid}::scheduled-agent-job`;
const SCHEDULED_PROMPT_MARK = '[isolated scheduled background turn]';
const EXPIRED_NOTICE = '_Previous session expired_ — starting fresh. Send a message to begin.';

type SessionDouble = (typeof sessionDoubles)[number];

type CheckpointRow = {
  session_id: string | null;
  claude_pid: number | null;
  session_status: string;
  completed_logical_turn_id: string | null;
  completed_manager_id: string | null;
  completed_inbound_seq: number | null;
};

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg-interactive-1',
    chatJid: dmJid,
    senderJid: dmJid,
    senderName: 'Test User',
    content: 'interactive question',
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

function storedMessage(chatJid: string, content: string): StoredMessage {
  return {
    pk: 1,
    chatJid,
    conversationKey: toConversationKey(chatJid),
    senderJid: chatJid,
    senderName: 'Test User',
    messageId: `stored-${content}`,
    content,
    contentType: 'text',
    isFromMe: false,
    timestamp: Math.floor(Date.now() / 1000) - 60,
    quotedMessageId: null,
    enrichmentProcessedAt: null,
    enrichmentRetries: 0,
    createdAt: new Date().toISOString(),
    mediaPath: null,
    contentText: content,
  };
}

function turnText(input: unknown): string {
  if (typeof input === 'string') return input;
  const structured = input as { userText?: string; applicationContext?: readonly string[] };
  return [structured.applicationContext?.join('\n') ?? '', structured.userText ?? ''].join('\n');
}

async function waitForInFlightTurn(matcher: (text: string) => boolean, timeout = 4_000): Promise<SessionDouble> {
  let found: SessionDouble | undefined;
  await vi.waitFor(() => {
    found = sessionDoubles.find(
      (s) => s.turnInFlight && s.turnsSent.some((t) => matcher(turnText(t))),
    );
    expect(found).toBeDefined();
  }, { timeout });
  return found!;
}

describe('scheduled turn checkpoint attribution and resume-failure visibility (#3570)', () => {
  let db: Database;
  let engine: DurabilityEngine;
  let runtime: AgentRuntime;

  function status(seq: number): string {
    return (db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(seq) as {
      processing_status: string;
    }).processing_status;
  }

  function checkpoint(key: string): CheckpointRow | undefined {
    return db.raw.prepare(
      `SELECT session_id, claude_pid, session_status, completed_logical_turn_id,
              completed_manager_id, completed_inbound_seq
       FROM session_checkpoints WHERE conversation_key = ?`,
    ).get(key) as CheckpointRow | undefined;
  }

  function terminalRecord(seq: number): { logical_turn_id: string; manager_id: string } {
    return db.raw.prepare(
      'SELECT logical_turn_id, manager_id FROM turn_terminal_records WHERE inbound_seq = ?',
    ).get(seq) as { logical_turn_id: string; manager_id: string };
  }

  function makeRuntime(): AgentRuntime {
    const created = new AgentRuntime(db, makeMessenger(), 'test', { sessionScope: 'per_chat' });
    installFakePerChatMcpSocketManager(created);
    created.setDurability(engine);
    return created;
  }

  async function driveInteractiveToComplete(chatJid: string, messageId: string): Promise<number> {
    const seq = engine.journalInbound(messageId, toConversationKey(chatJid), chatJid, 'agent');
    void runtime.handleMessage(makeMsg({ messageId, chatJid, senderJid: chatJid, inboundSeq: seq }));
    const session = await waitForInFlightTurn((t) => t.includes('interactive question'));
    session.emit({ type: 'result', text: 'On it.' });
    await vi.waitFor(() => expect(status(seq)).toBe('complete'), { timeout: 4_000 });
    return seq;
  }

  async function driveScheduledToComplete(chatJid: string): Promise<{ seq: number; session: SessionDouble }> {
    const ack = runtime.dispatchAgentJob({
      beadId: 7,
      triggerId: 5,
      occurrenceId: 11,
      prompt: 'Check for a scholarship reply.',
      title: 'Scholarship check',
      reportChatJid: chatJid,
    });
    expect(ack.dispatched, ack.detail).toBe(true);
    const seq = Number(/inbound seq (\d+)/.exec(ack.detail ?? '')![1]);
    const session = await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));
    session.emit({ type: 'result', text: 'NO_REPLY' });
    await vi.waitFor(() => expect(status(seq)).toBe('complete'), { timeout: 4_000 });
    return { seq, session };
  }

  function interactiveSessionFor(chatJid: string): SessionDouble {
    const found = sessionDoubles.find(
      (s) => s.ctorOpts.chatJid === chatJid && !s.persistenceKey.endsWith('::scheduled-agent-job'),
    );
    expect(found).toBeDefined();
    return found!;
  }

  /** Restart: stop the first runtime and boot a second one on the SAME database. */
  async function restartWithProactiveResume(
    beforeStart?: (next: AgentRuntime) => void,
  ): Promise<SessionDouble[]> {
    await runtime.shutdown();
    await prepareRuntimeHome();
    const bootIndex = sessionDoubles.length;
    mockConfig.proactiveResumeOnStartup = true;
    runtime = makeRuntime();
    beforeStart?.(runtime);
    await runtime.start();
    return sessionDoubles.slice(bootIndex);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetDoubles();
    mockConfig.proactiveResumeOnStartup = false;
    db = new Database(':memory:');
    db.open();
    engine = new DurabilityEngine(db);
    harnessRef.current = {
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
        db.raw.prepare(`UPDATE outbound_ops SET status = 'echoed', echoed_at = datetime('now') WHERE id = ?`).run(opId);
        return opId;
      },
      recordLifecycleStart: (persistenceKey, sessionId, pid) => {
        engine.upsertSessionCheckpoint(persistenceKey, {
          sessionId,
          claudePid: pid,
          sessionStatus: 'active',
        });
      },
      rejectResume: false,
    };
    runtime = makeRuntime();
  });

  afterEach(async () => {
    for (const session of sessionDoubles) {
      if (session.turnInFlight) session.emit({ type: 'result', text: 'NO_REPLY' });
    }
    await runtime?.shutdown();
    db.close();
  });

  it('M1: a scheduled turn leaves the chat checkpoint on the interactive session and keeps its own values under the scheduled key', async () => {
    const interactiveSeq = await driveInteractiveToComplete(dmJid, 'msg-m1-interactive');
    const interactive = interactiveSessionFor(dmJid);
    const interactiveTerminal = terminalRecord(interactiveSeq);

    const { session: scheduled } = await driveScheduledToComplete(dmJid);
    expect(scheduled.persistenceKey).toBe(scheduledPersistenceKey);
    // Non-vacuity: the two managers really are distinct processes and sessions.
    expect(scheduled.identity.sessionId).not.toBe(interactive.identity.sessionId);
    expect(scheduled.identity.pid).not.toBe(interactive.identity.pid);

    expect(checkpoint(dmKey)).toMatchObject({
      session_id: interactive.identity.sessionId,
      claude_pid: interactive.identity.pid,
      session_status: 'active',
      completed_inbound_seq: interactiveSeq,
      completed_logical_turn_id: interactiveTerminal.logical_turn_id,
      completed_manager_id: interactiveTerminal.manager_id,
    });
    // The scheduled manager's own lifecycle row is intact and never adopted
    // the chat's identity.
    expect(checkpoint(scheduledPersistenceKey)).toMatchObject({
      session_id: scheduled.identity.sessionId,
      claude_pid: scheduled.identity.pid,
      session_status: 'active',
    });
  });

  it('M2: after a scheduled turn, a DM restart proactively resumes the chat\'s own session', async () => {
    await driveInteractiveToComplete(dmJid, 'msg-m2-interactive');
    const interactive = interactiveSessionFor(dmJid);
    const { session: scheduled } = await driveScheduledToComplete(dmJid);
    expect(scheduled.identity.sessionId).not.toBe(interactive.identity.sessionId);

    const booted = await restartWithProactiveResume();

    const resumed = booted.find((s) => s.ctorOpts.chatJid === dmJid);
    expect(resumed).toBeDefined();
    await vi.waitFor(() => expect(resumed!.spawnSession).toHaveBeenCalled());
    expect(resumed!.spawnSession).toHaveBeenCalledWith(interactive.identity.sessionId);
    expect(resumed!.spawnSession).not.toHaveBeenCalledWith(scheduled.identity.sessionId);
  });

  describe('M3: a proactive resume failure is visible to that chat and recovers its context', () => {
    async function seedTwoChats(): Promise<void> {
      await driveInteractiveToComplete(dmJid, 'msg-m3-a');
      await driveInteractiveToComplete(otherDmJid, 'msg-m3-b');
      expect(checkpoint(dmKey)?.session_id).not.toBe(checkpoint(otherDmKey)?.session_id);
      vi.mocked(getRecentMessages).mockImplementation((_db, conversationKey) => [
        storedMessage(conversationKey === dmKey ? dmJid : otherDmJid, `earlier talk in ${conversationKey}`),
      ]);
    }

    const bothChats = [
      { chatJid: dmJid, conversationKey: dmKey },
      { chatJid: otherDmJid, conversationKey: otherDmKey },
    ];

    function expiredNotices(events: readonly StartupNotificationEvent[]): Array<{ chatJid: string; text: string }> {
      return events
        .filter((event) => event.kind === 'expired_session_notice')
        .map(({ chatJid, text }) => ({ chatJid, text }));
    }

    async function expectRecovered(booted: SessionDouble[], chatJid: string, conversationKey: string): Promise<void> {
      const session = booted.find((s) => s.ctorOpts.chatJid === chatJid);
      expect(session).toBeDefined();
      // Recovery spawns a FRESH session (no resume id) and replays recent
      // chat history into it.
      await vi.waitFor(() => expect(session!.spawnSession).toHaveBeenLastCalledWith());
      await vi.waitFor(() => {
        expect(session!.turnsSent.map(turnText)).toContainEqual(
          expect.stringContaining('[CONTEXT RECOVERY — prior session expired]'),
        );
      });
      expect(session!.turnsSent.map(turnText).join('\n')).toContain(`earlier talk in ${conversationKey}`);
      // Recovery turns are serialized on the runtime's turn chain; the
      // provider's terminal result releases the next chat's recovery.
      if (session!.turnInFlight) session!.emit({ type: 'result', text: null });
    }

    /** Recover every chat, in whatever order the turn chain serves them. */
    async function expectAllRecovered(
      booted: SessionDouble[],
      chats: ReadonlyArray<{ chatJid: string; conversationKey: string }>,
    ): Promise<void> {
      const remaining = [...chats];
      while (remaining.length > 0) {
        let next = -1;
        await vi.waitFor(() => {
          next = remaining.findIndex(({ chatJid }) => booted.some((s) => s.ctorOpts.chatJid === chatJid
            && s.turnsSent.some((t) => turnText(t).includes('[CONTEXT RECOVERY'))));
          expect(next).toBeGreaterThanOrEqual(0);
        });
        const [chat] = remaining.splice(next, 1);
        await expectRecovered(booted, chat!.chatJid, chat!.conversationKey);
      }
    }

    it('two failing chats each get their own deferred notice and their own context recovery', async () => {
      await seedTwoChats();
      harnessRef.current!.rejectResume = true;

      const booted = await restartWithProactiveResume();

      await expectAllRecovered(booted, bothChats);
      const notices = expiredNotices(runtime.popStartupChatNotifications());
      expect(notices).toHaveLength(2);
      expect(notices).toEqual(expect.arrayContaining([
        { chatJid: dmJid, text: EXPIRED_NOTICE },
        { chatJid: otherDmJid, text: EXPIRED_NOTICE },
      ]));
    });

    it('a pending restart-loop alert is kept and does not swallow either chat notice', async () => {
      await seedTwoChats();
      harnessRef.current!.rejectResume = true;
      const alert: StartupNotificationEvent = {
        kind: 'restart_loop_guard_alert',
        chatJid: 'admin@s.whatsapp.net',
        text: 'guard tripped',
      };

      const booted = await restartWithProactiveResume((next) => {
        (next as unknown as { pendingStartupEvent: StartupNotificationEvent | null }).pendingStartupEvent = alert;
      });

      await expectAllRecovered(booted, bothChats);
      expect(runtime.popStartupNotificationEvent()).toEqual(alert);
      const notices = expiredNotices(runtime.popStartupChatNotifications());
      expect(notices.map((notice) => notice.chatJid).sort()).toEqual([dmJid, otherDmJid].sort());
    });

    it('once startup notices are drained, a later resume failure goes straight to that chat\'s queue', async () => {
      await seedTwoChats();
      const booted = await restartWithProactiveResume();
      const resumed = booted.find((s) => s.ctorOpts.chatJid === dmJid)!;
      await vi.waitFor(() => expect(resumed.spawnSession).toHaveBeenCalledWith(expect.any(String)));
      expect(runtime.popStartupChatNotifications()).toEqual([]);

      // The provider rejected the resumed session after spawn (exit 1, no init).
      resumed.ctorOpts.onResumeFailed?.();

      await vi.waitFor(() => {
        const chatQueue = queueDoubles.filter((q) => q.targetChatJid === dmJid).at(-1);
        expect(chatQueue?.enqueueText).toHaveBeenCalledWith(EXPIRED_NOTICE);
      });
      const otherQueues = queueDoubles.filter((q) => q.targetChatJid === otherDmJid);
      for (const queue of otherQueues) expect(queue.enqueueText).not.toHaveBeenCalledWith(EXPIRED_NOTICE);
      await expectRecovered(booted, dmJid, dmKey);
    });
  });

  it('a resume failure never respawns a scheduled scope or a chat whose ownership moved, but the moved chat is still told', async () => {
    await driveInteractiveToComplete(dmJid, 'msg-guards-interactive');
    const { session: scheduled } = await driveScheduledToComplete(dmJid);
    const interactive = interactiveSessionFor(dmJid);
    const state = runtime as unknown as {
      handleResumeFailed(chatJid: string, target?: { mapKey: string; session: unknown }): void;
      chatSessions: Map<string, unknown>;
    };
    const scheduledSpawns = scheduled.spawnSession.mock.calls.length;
    const interactiveSpawns = interactive.spawnSession.mock.calls.length;

    state.handleResumeFailed(dmJid, { mapKey: scheduledPersistenceKey, session: scheduled });
    // A stale manager for the chat's own scope: the live owner is `interactive`.
    const stale = makeSessionDouble({ chatJid: dmJid, persistenceConversationKey: 'stale-owner', onEvent: () => {} });
    state.handleResumeFailed(dmJid, { mapKey: dmJid, session: stale });
    await Promise.resolve();

    expect(scheduled.spawnSession).toHaveBeenCalledTimes(scheduledSpawns);
    expect(interactive.spawnSession).toHaveBeenCalledTimes(interactiveSpawns);
    expect(stale.spawnSession).not.toHaveBeenCalled();
    expect(state.chatSessions.get(dmJid)).toBe(interactive);
    expect(runtime.popStartupChatNotifications()).toEqual([
      { kind: 'expired_session_notice', chatJid: dmJid, text: EXPIRED_NOTICE },
    ]);
  });

  it('M4: after a scheduled turn the classifier rates the chat\'s resident session authoritative_live', async () => {
    await driveInteractiveToComplete(dmJid, 'msg-m4-interactive');
    const interactive = interactiveSessionFor(dmJid);
    const { session: scheduled } = await driveScheduledToComplete(dmJid);

    // session-db is mocked here, so write the two resident agent_sessions rows
    // the real SessionManager would have created (distinct ids, pids, keys).
    const insert = db.raw.prepare(
      `INSERT INTO agent_sessions (claude_pid, started_in_directory, chat_jid, workspace_key, started_at, status, provider, session_id)
       VALUES (?, '/tmp', ?, ?, datetime('now'), 'active', 'claude-cli', ?)`,
    );
    insert.run(interactive.identity.pid, dmJid, dmKey, interactive.identity.sessionId);
    insert.run(scheduled.identity.pid, dmJid, scheduledPersistenceKey, scheduled.identity.sessionId);

    const results = classifyActiveSessions(db, engine, () => ({ alive: true, owned: true }));

    const bySession = new Map(results.map((r) => [r.sessionId, r]));
    expect(bySession.get(interactive.identity.sessionId)).toMatchObject({
      classification: 'authoritative_live',
      conversationKey: dmKey,
    });
    expect(bySession.get(scheduled.identity.sessionId)).toMatchObject({
      classification: 'authoritative_live',
      conversationKey: scheduledPersistenceKey,
    });
  });
});
