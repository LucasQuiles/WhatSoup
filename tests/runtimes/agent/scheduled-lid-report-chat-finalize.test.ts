// Scheduled agent job whose report chat is a MAPPED @lid contact.
//
// Every durable artifact of the turn (turn identity, outbound ops, terminal
// record) is keyed by canonicalConversationKey — for a mapped LID that is the
// resolved PHONE digits. The synthetic inbound the dispatch journals must use
// the same key: a raw-LID journal key makes terminal finalization reject the
// inbound identity, the transaction rolls back, and the inbound stays
// 'processing' behind delivered replies until crash recovery fails it.
//
// Harness: REAL AgentRuntime + REAL SQLite durability; only the provider
// boundary and the outbound transport are doubled (the pattern of
// scheduled-turn-lifecycle.test.ts). The queue double writes REAL echoed
// outbound_ops rows under the runtime-supplied conversation key.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Messenger, IncomingMessage } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
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
import { AgentRuntime, type AgentRuntimeOptions } from '../../../src/runtimes/agent/runtime.ts';
import { emitAlert, emitAlertChecked } from '../../../src/lib/emit-alert.ts';
import { installFakePerChatMcpSocketManager } from './helpers/fake-per-chat-mcp-socket-manager.ts';

// ─── Shared fixtures (synthetic identities only) ────────────────────────────

const LID_LOCAL = '900000000000042';
const LID_JID = `${LID_LOCAL}@lid`;
const PHONE_DIGITS = '15550004242';
const PHONE_JID = `${PHONE_DIGITS}@s.whatsapp.net`;
const SCHEDULED_PROMPT_MARK = '[isolated scheduled background turn]';
const FINALIZATION_ALERT = 'agent_turn_finalization_failed';

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
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

function finalizationAlertCalls(): unknown[][] {
  return [
    ...vi.mocked(emitAlert).mock.calls,
    ...vi.mocked(emitAlertChecked).mock.calls,
  ].filter((call) => (call as unknown[]).includes(FINALIZATION_ALERT)) as unknown[][];
}

describe('scheduled agent job reporting to a mapped @lid chat', () => {
  let db: Database;
  let engine: DurabilityEngine;
  let runtime: AgentRuntime | undefined;
  let finalizeErrors: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    resetDoubles();
    db = new Database(':memory:');
    db.open();
    db.raw.prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)').run(LID_LOCAL, PHONE_JID);
    engine = new DurabilityEngine(db);
    finalizeErrors = [];
    const finalize = engine.finalizeTurnTerminal.bind(engine);
    vi.spyOn(engine, 'finalizeTurnTerminal').mockImplementation((params) => {
      try {
        return finalize(params);
      } catch (err) {
        finalizeErrors.push(err instanceof Error ? err.message : String(err));
        throw err;
      }
    });
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

  function inboundRow(seq: number): { processing_status: string; conversation_key: string; chat_jid: string } {
    return db.raw.prepare(
      'SELECT processing_status, conversation_key, chat_jid FROM inbound_events WHERE seq = ?',
    ).get(seq) as { processing_status: string; conversation_key: string; chat_jid: string };
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
  }
});
