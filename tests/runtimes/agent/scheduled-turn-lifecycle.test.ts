// #3374 P0 eradication regression — scheduled agent-job TURN LIFECYCLE settlement.
//
// The existing isolation tests (scheduled-agent-job-isolation.test.ts + the
// scheduled-turn session-separation test in runtime-secondhalf-branches.test.ts)
// prove session SEPARATION and crash retirement. They do not prove lifecycle
// SETTLEMENT: that a scheduled synthetic turn reaches a durable terminal
// processing_status, releases its TurnQueue, and cannot wedge the interactive
// lane when the provider terminal result never arrives.
//
// Matrix (per sessionScope mode — single, shared, per_chat non-sandbox,
// sandbox per-chat):
//   1. dispatch a scheduled synthetic turn; assert the scheduler publication ack;
//   2. simulate useful tool delivery mid-turn (tool_use/tool_result events);
//   3. emit the provider terminal result;
//   4. assert the synthetic inbound reaches a terminal processing_status;
//   5. assert the scheduled lane holds no active turn within a bound;
//   6. dispatch a subsequent interactive inbound; assert it reaches 'complete';
//   7. NEGATIVE: repeat with the provider terminal result WITHHELD and assert
//      bounded containment. Where containment does not exist on main the
//      missing property is encoded as `it.fails` (committed `.skip` is blocked
//      by repo hygiene): the test asserts the DESIRED property and passes only
//      while main lacks it — landing the fix flips it red, forcing promotion
//      to a normal test. Never a fake-green assertion.
//
// Harness: REAL AgentRuntime + REAL RuntimeTurnCoordinator + REAL TurnQueues +
// REAL SQLite durability (Database(':memory:') + DurabilityEngine). Only the
// provider boundary is faked, following the module-mock pattern of
// codex-turn-lifecycle.test.ts / runtime-secondhalf-branches.test.ts — with one
// deliberate strengthening: the fake SessionManager's sendTurn() resolves ONLY
// when completeProviderTurn() fires (the real session.ts contract, see
// completeProviderTurn/waitForProviderTurnToTerminalize). That is what lets a
// withheld terminal result genuinely pin TurnQueue.drain() — the #3374 wedge —
// instead of the mock resolving instantly and vacuously passing every case.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Messenger, IncomingMessage } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import { toConversationKey } from '../../../src/core/conversation-key.ts';

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
    stateRoot: `/tmp/whatsoup-test-state-sched-lifecycle-${process.pid}`,
    restartLoopGuard: { enabled: true, maxRestarts: 3, windowMs: 300_000 },
    startupNotifications: false,
    proactiveResumeOnStartup: false,
    mediaDir: `/tmp/whatsoup-test-media-sched-lifecycle-${process.pid}`,
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
import { __setRuntimeLifecycleEmitterForTests, type LifecycleEmitInput } from '../../../src/core/observability/lifecycle-emission.ts';
import { TurnQueue } from '../../../src/runtimes/agent/turn-queue.ts';
import { emitAlertChecked } from '../../../src/lib/emit-alert.ts';
import { installFakePerChatMcpSocketManager } from './helpers/fake-per-chat-mcp-socket-manager.ts';

// ─── Shared fixtures ────────────────────────────────────────────────────────

const groupJid = 'test-scheduled-group@g.us';
const otherChatJid = '15550002@s.whatsapp.net';
const senderJid = '15550001@s.whatsapp.net';
const SCHEDULED_PROMPT_MARK = '[isolated scheduled background turn]';
// Bound for asserting a DESIRED-but-missing property inside it.fails probes:
// long enough for the runtime to settle if the property held, short enough to
// keep the suite well under the 10s per-test budget.
const GAP_PROBE_BOUND_MS = 1_500;
// The user-facing notice handleMessage's turn-chain catch sends on a genuine
// processing failure (runtime.ts). A wedged-lane release is not one.
const PROCESSING_FAILURE_NOTICE = 'Something went wrong processing that message. Try again?';

function makeMessenger(): { messenger: Messenger; sentMessages: Array<{ jid: string; text: string }> } {
  const sentMessages: Array<{ jid: string; text: string }> = [];
  const messenger = {
    sendMessage: vi.fn(async (jid: string, text: string) => {
      sentMessages.push({ jid, text });
      return { waMessageId: null };
    }),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
  return { messenger, sentMessages };
}

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg-interactive-1',
    chatJid: groupJid,
    senderJid,
    senderName: 'Test User',
    content: 'interactive question',
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

/** Provider-turn text can be a string or a structured turn; normalize for matching. */
function turnText(input: unknown): string {
  if (typeof input === 'string') return input;
  const structured = input as { userText?: string; applicationContext?: readonly string[] };
  return [structured.applicationContext?.join('\n') ?? '', structured.userText ?? ''].join('\n');
}

type SessionDouble = (typeof sessionDoubles)[number];

/** The session double currently holding an in-flight turn whose text matches. */
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

describe('scheduled agent-job turn lifecycle (#3374)', () => {
  let db: Database;
  let engine: DurabilityEngine;
  let runtime: AgentRuntime;
  let messenger: Messenger;

  /**
   * Text the runtime pushed through sendDirect. chat-transport.ts routes a
   * direct send to the chat's outbound queue (enqueueText) whenever one exists,
   * which it always does here, so the queue doubles — not the messenger — are
   * where a direct send is observable.
   */
  function directSendTexts(): string[] {
    return queueDoubles.flatMap((q) => q.enqueueText.mock.calls.map((call) => call[0] as string));
  }

  function status(seq: number): string {
    return (db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(seq) as {
      processing_status: string;
    }).processing_status;
  }

  /**
   * Model the race guard 7 exists for: the provider terminal HAS arrived (the
   * real SessionManager clears providerTurnInFlight at terminalization) while
   * the runtime lane has not been released yet, so ordinary finalization is
   * still racing the sweep. The double conflates those two states, so the
   * status is overridden for this one session only.
   */
  function reportProviderTurnTerminalized(session: SessionDouble): void {
    const terminalized = { ...session.getStatus(), turnInFlight: false };
    session.getStatus.mockReturnValue(terminalized as ReturnType<typeof session.getStatus>);
  }

  /** emitAlertChecked calls carrying the wedged-lane release key. */
  function wedgeReleaseAlerts(): unknown[] {
    return vi.mocked(emitAlertChecked).mock.calls.filter(
      (call) => call[1] === 'agent_wedged_turn_released',
    );
  }

  /**
   * Evidence string of the one wedged-lane release alert. #3374 C7: whether a
   * provider child was actually reaped is read off the emitted operator record
   * rather than inferred from the call, so an untruthful record fails here.
   */
  function wedgeReleaseEvidence(): string {
    const alerts = wedgeReleaseAlerts() as unknown[][];
    expect(alerts).toHaveLength(1);
    return alerts[0]![3] as string;
  }

  /**
   * Spy on the coordinator call the release makes. Its argument is a freshly
   * constructed WedgedTurnReclaimedError, so "never called" is direct evidence
   * that no such error was constructed — arguments evaluate at call time.
   */
  function spyOnTurnCompletionRejection() {
    const coordinator = (runtime as unknown as {
      runtimeTurnCoordinator: { rejectRuntimeTurnCompletion: (...args: never[]) => boolean };
    }).runtimeTurnCoordinator;
    return vi.spyOn(coordinator, 'rejectRuntimeTurnCompletion');
  }

  /** Who owns the durable terminal: the sweep writes 'stale_reclaim'. */
  function failureClass(seq: number): string | null {
    return (db.raw.prepare('SELECT failure_class FROM inbound_events WHERE seq = ?').get(seq) as {
      failure_class: string | null;
    }).failure_class;
  }

  function backdate(seq: number, interval: string): void {
    db.raw.prepare(`UPDATE inbound_events SET received_at = datetime('now', ?) WHERE seq = ?`).run(interval, seq);
  }

  function makeRuntime(options: AgentRuntimeOptions): void {
    runtime = new AgentRuntime(db, messenger, 'test', options);
    installFakePerChatMcpSocketManager(runtime);
    runtime.setDurability(engine);
  }

  /** Cell 1: dispatch + scheduler publication acknowledgment; returns the journal seq. */
  function dispatchScheduled(prompt = 'Check for a scholarship reply.', occurrenceId = 11): number {
    const ack = runtime.dispatchAgentJob({
      beadId: 7,
      triggerId: 5,
      occurrenceId,
      prompt,
      title: 'Scholarship check',
      reportChatJid: groupJid,
    });
    expect(ack.dispatched, ack.detail).toBe(true);
    const seqMatch = /inbound seq (\d+)/.exec(ack.detail ?? '');
    expect(seqMatch).not.toBeNull();
    const seq = Number(seqMatch![1]);
    // Durable ownership before ack (#2144): the synthetic inbound is journaled.
    expect(status(seq)).toBe('processing');
    return seq;
  }

  /** Cell 2: realistic mid-turn provider traffic on the scheduled session. */
  function emitMidTurnToolDelivery(session: SessionDouble): void {
    session.emit({ type: 'assistant_text', text: 'checking', itemId: 'item-1' });
    session.emit({ type: 'tool_use', toolName: 'send_message', toolId: 'tool-1', toolInput: {} });
    session.emit({ type: 'tool_result', isError: false, toolId: 'tool-1', toolName: 'send_message', content: 'sent' });
  }

  /** Cell 3: the provider terminal boundary. */
  function emitTerminal(session: SessionDouble, text: string | null = 'NO_REPLY'): void {
    session.emit({ type: 'result', text });
  }

  async function driveInteractiveToComplete(
    msg: Partial<IncomingMessage> = {},
    timeout = 4_000,
  ): Promise<number> {
    const messageId = (msg.messageId as string | undefined) ?? `msg-interactive-${Date.now()}`;
    const chatJid = (msg.chatJid as string | undefined) ?? groupJid;
    const seq = engine.journalInbound(messageId, toConversationKey(chatJid), chatJid, 'agent');
    void runtime.handleMessage(makeMsg({ ...msg, messageId, chatJid, inboundSeq: seq }));
    const session = await waitForInFlightTurn((t) => t.includes('interactive question'), timeout);
    emitTerminal(session, 'On it.');
    await vi.waitFor(() => expect(status(seq)).toBe('complete'), { timeout });
    return seq;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetDoubles();
    db = new Database(':memory:');
    db.open();
    engine = new DurabilityEngine(db);
    ({ messenger } = makeMessenger());
    harnessRef.current = {
      // A queue double's answer op, already echoed: mirrors a delivered reply
      // whose WhatsApp echo landed (same shape the durability tests force).
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

  // Set by tests whose scenario makes clean shutdown IMPOSSIBLE by design
  // (a W2-reclaimed journal row leaves the live turn's late terminal with no
  // eligible inbound row to finalize against — fail-closed on shutdown).
  let expectUnfinalizableShutdown = false;

  afterEach(async () => {
    // Release any still-withheld provider turn before shutdown: a pinned
    // TurnQueue processor would otherwise hang runtime.shutdown() past the
    // test timeout. Wedge assertions always run BEFORE this cleanup.
    for (const session of sessionDoubles) {
      if (session.turnInFlight) emitTerminal(session);
    }
    if (expectUnfinalizableShutdown) {
      expectUnfinalizableShutdown = false;
      await expect(runtime.shutdown()).rejects.toThrow('AgentRuntime shutdown failed');
    } else {
      await runtime?.shutdown();
    }
    db.close();
  });

  // ─── per_chat (non-sandbox) — the #3341 isolation port surface ────────────

  describe('per_chat (non-sandbox)', () => {
    const scheduledMapKey = `${groupJid}::scheduled-agent-job`;

    beforeEach(() => {
      makeRuntime({ sessionScope: 'per_chat' });
    });

    function scheduledQueue(): TurnQueue | undefined {
      return (runtime as unknown as { perChatTurnQueues: Map<string, TurnQueue> })
        .perChatTurnQueues.get(scheduledMapKey);
    }

    function interactiveQueue(): TurnQueue | undefined {
      return (runtime as unknown as { perChatTurnQueues: Map<string, TurnQueue> })
        .perChatTurnQueues.get(groupJid);
    }

    it('cells 1-6: scheduled turn settles durably, releases its queue, and a subsequent interactive turn completes', async () => {
      const seq = dispatchScheduled();

      // The scheduled turn crosses the provider boundary on the isolated session.
      const session = await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));
      expect(session.ctorOpts.persistenceConversationKey).toBe(scheduledMapKey);

      // Cell 2: mid-turn tool delivery must not terminalize the turn.
      emitMidTurnToolDelivery(session);
      expect(session.turnInFlight).toBe(true);
      expect(scheduledQueue()?.activeTurn?.sourceMessageId).toMatch(/^agentjob-5-/);
      expect(status(seq)).toBe('processing');

      // Cell 3 → 4: provider terminal result → durable terminal processing_status.
      emitTerminal(session);
      await vi.waitFor(() => expect(status(seq)).toBe('complete'), { timeout: 4_000 });

      // Cell 5: the scheduled queue holds no active turn within a bound.
      await vi.waitFor(() => {
        expect(scheduledQueue()?.activeTurn ?? null).toBeNull();
        expect(scheduledQueue()?.pending ?? 0).toBe(0);
      }, { timeout: 4_000 });

      // Cell 6: a subsequent interactive inbound reaches 'complete'.
      await driveInteractiveToComplete();
    });

    it('cell 7 (CRITICAL negative): withheld provider terminal wedges ONLY the scheduled lane; the interactive lane still completes and the stuck turn stays observable', async () => {
      const seq = dispatchScheduled();
      const scheduledSession = await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));
      emitMidTurnToolDelivery(scheduledSession);

      // The wedge is observable: the scheduled TurnQueue pins its active turn.
      await vi.waitFor(() => {
        expect(scheduledQueue()?.activeTurn?.sourceMessageId).toMatch(/^agentjob-5-/);
      }, { timeout: 4_000 });
      expect(scheduledQueue()?.isProcessing).toBe(true);
      expect(status(seq)).toBe('processing');

      // Isolation: the interactive lane completes while the scheduled lane is wedged.
      await driveInteractiveToComplete();

      // The scheduled lane is STILL wedged after the interactive turn completed —
      // the interactive lane neither freed nor consumed the stuck scheduled turn.
      expect(scheduledSession.turnInFlight).toBe(true);
      expect(scheduledQueue()?.activeTurn?.sourceMessageId).toMatch(/^agentjob-5-/);
      expect(interactiveQueue()?.activeTurn ?? null).toBeNull();
      expect(status(seq)).toBe('processing');
    });

    it('cell 7 reclamation: the W2 stuck-inbound sweep respects its 24h grace for an in-flight turn', async () => {
      const seq = dispatchScheduled();
      await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));

      // Inside the grace window the sweep must NOT touch the in-flight row.
      // (Post-grace reclamation AND the coupled lane release are owned by the
      // promoted coupling test below.)
      expect(engine.sweepStuckInbound()).toMatchObject({ failedStale: 0 });
      expect(status(seq)).toBe('processing');
    });

    // #3374 ask 2 — PROMOTED from the fix-shaped it.fails gap probe: the W2
    // sweep's stale-reclaim listener now releases the runtime lane too. The
    // release rejects the held turn's runtime completion, resolves the
    // session's provider-turn promise (a killed real child does the same from
    // its exit handler), and the queue's ordinary processor-error finalization
    // recognizes the sweep-owned durable terminal (reclaimed_by_sweep): the
    // runtime state is retired through the standard post-effects — no
    // incident, no supervisor retention — leaving the lane REUSABLE and
    // shutdown clean (asserted implicitly by afterEach's normal shutdown).
    it('cell 7 reclamation: durable reclamation also releases the wedged TurnQueue (#3374 ask-2 coupling)', async () => {
      const seq = dispatchScheduled();
      await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));
      await vi.waitFor(() => {
        expect(scheduledQueue()?.activeTurn?.sourceMessageId).toMatch(/^agentjob-5-/);
      }, { timeout: 4_000 });

      backdate(seq, '-25 hours');
      expect(engine.sweepStuckInbound()).toMatchObject({ failedStale: 1 });

      // Reclaiming the durable row also releases the runtime lane (#3374
      // ask 2): the sweep's reclaim listener rejects the held turn's runtime
      // completion and drives crash finalization, so the pinned processor
      // settles asynchronously.
      await vi.waitFor(() => {
        expect(scheduledQueue()?.activeTurn ?? null).toBeNull();
      }, { timeout: 4_000 });

      // Release must leave the lane REUSABLE, not merely unblocked: the
      // reclaimed turn's runtime-FIFO context must not leak (a retained
      // owner makes every successor fail pre-dispatch with "FIFO already
      // has an active owner"), and a successor scheduled turn must reach
      // the provider.
      await vi.waitFor(() => {
        expect(
          (runtime as unknown as { perChatRuntimeTurnContexts: Map<string, unknown[]> })
            .perChatRuntimeTurnContexts.get(scheduledMapKey) ?? [],
        ).toHaveLength(0);
      }, { timeout: 4_000 });

      // Distinct occurrence id: the synthetic message id embeds it, and a
      // same-second successor with the same occurrence would collide in the
      // journal (a harness artifact, not lane behavior).
      dispatchScheduled('Successor after reclamation.', 12);
      await waitForInFlightTurn((t) => t.includes('Successor after reclamation.'));
    });

    // #3374 C7 — the managed-provider wedge. `reapWedgedProviderChild` returns
    // false when the session holds no local child (`this.child === null`),
    // which is every managed-loop provider: nothing is killed and the remote
    // request is left outstanding. The lane release itself still has to happen
    // (settlement never depended on a child existing), but the operator record
    // must not read as a reap that took place.
    // Call site: the per-chat reclaim loop in releaseWedgedReclaimedLanes.
    it('cell 7 reclamation MANAGED PROVIDER: a release that reaped no child says so (#3374 C7)', async () => {
      const seq = dispatchScheduled();
      const session = await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));
      session.reapWedgedProviderChild.mockReturnValue(false);
      await vi.waitFor(() => {
        expect(scheduledQueue()?.activeTurn?.sourceMessageId).toMatch(/^agentjob-5-/);
      }, { timeout: 4_000 });

      backdate(seq, '-25 hours');
      expect(engine.sweepStuckInbound()).toMatchObject({ failedStale: 1 });

      // The reap ran and reported that it killed nothing.
      expect(session.reapWedgedProviderChild).toHaveBeenCalledTimes(1);
      expect(wedgeReleaseEvidence()).toContain('reap=reap_skipped_no_child');

      // Release is still unconditional: the lane is freed either way.
      await vi.waitFor(() => {
        expect(scheduledQueue()?.activeTurn ?? null).toBeNull();
      }, { timeout: 4_000 });
    });

    // NEGATIVE CONTROL for the record above: a lane whose provider child WAS
    // reaped keeps the reaped wording, so the new detail cannot be a constant
    // and cannot be the release's only spelling.
    it('cell 7 reclamation NEGATIVE: a release that DID reap a child is not labelled skipped (#3374 C7 control)', async () => {
      const seq = dispatchScheduled();
      const session = await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));
      session.reapWedgedProviderChild.mockReturnValue(true);
      await vi.waitFor(() => {
        expect(scheduledQueue()?.activeTurn?.sourceMessageId).toMatch(/^agentjob-5-/);
      }, { timeout: 4_000 });

      backdate(seq, '-25 hours');
      expect(engine.sweepStuckInbound()).toMatchObject({ failedStale: 1 });

      expect(session.reapWedgedProviderChild).toHaveBeenCalledTimes(1);
      expect(wedgeReleaseEvidence()).toContain('reap=reaped_child');
      expect(wedgeReleaseEvidence()).not.toContain('reap_skipped_no_child');

      await vi.waitFor(() => {
        expect(scheduledQueue()?.activeTurn ?? null).toBeNull();
      }, { timeout: 4_000 });
    });
  });

  // ─── shared mode — one session + one global FIFO for every chat ───────────

  describe('shared', () => {
    beforeEach(() => {
      makeRuntime({ sessionScope: 'shared' });
    });

    function globalQueue(): TurnQueue {
      return (runtime as unknown as { turnQueue: TurnQueue }).turnQueue;
    }

    it('cells 1-6: scheduled turn settles durably on the shared queue and a subsequent interactive turn completes', async () => {
      const seq = dispatchScheduled();
      const session = await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));

      emitMidTurnToolDelivery(session);
      expect(session.turnInFlight).toBe(true);
      expect(globalQueue().activeTurn?.sourceMessageId).toMatch(/^agentjob-5-/);
      expect(status(seq)).toBe('processing');

      emitTerminal(session);
      await vi.waitFor(() => expect(status(seq)).toBe('complete'), { timeout: 4_000 });

      await vi.waitFor(() => {
        expect(globalQueue().activeTurn).toBeNull();
        expect(globalQueue().pending).toBe(0);
      }, { timeout: 4_000 });

      await driveInteractiveToComplete();
    });

    it('cell 7 (negative): withheld provider terminal wedges the SHARED queue — the stuck turn is observable and a queued interactive turn is bounded behind it', async () => {
      const seq = dispatchScheduled();
      const session = await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));

      // Queue a subsequent interactive inbound behind the wedged scheduled turn.
      const messageId = 'msg-interactive-wedged';
      const iSeq = engine.journalInbound(messageId, toConversationKey(groupJid), groupJid, 'agent');
      void runtime.handleMessage(makeMsg({ messageId, inboundSeq: iSeq }));

      await vi.waitFor(() => expect(globalQueue().pending).toBe(1), { timeout: 4_000 });

      // Observable containment surface: the wedge is attributable — the active
      // turn is the scheduled synthetic, the interactive row is still open, and
      // the interactive turn never crossed the provider boundary.
      expect(globalQueue().activeTurn?.sourceMessageId).toMatch(/^agentjob-5-/);
      expect(status(seq)).toBe('processing');
      expect(status(iSeq)).toBe('processing');
      expect(session.turnsSent).toHaveLength(1);

      // Recovery once the terminal finally arrives: the queue advances and the
      // queued interactive turn runs to durable completion.
      emitTerminal(session);
      const interactiveSession = await waitForInFlightTurn((t) => t.includes('interactive question'));
      emitTerminal(interactiveSession, 'On it.');
      await vi.waitFor(() => expect(status(iSeq)).toBe('complete'), { timeout: 4_000 });
    });

    // OPEN GAP (#3374): shared mode has NO scheduled/interactive isolation on
    // main — the #3341 port routes scheduled jobs to an isolated session/queue
    // only in non-sandbox per_chat mode. In shared mode a withheld scheduled
    // terminal blocks every subsequent interactive turn (proven above). This
    // probe asserts the DESIRED isolation; it.fails keeps it green only while
    // the gap exists.
    it.fails('cell 7 isolation gap probe: interactive turn completes while a scheduled terminal is withheld (no shared-mode isolation on main)', async () => {
      dispatchScheduled();
      await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));
      await driveInteractiveToComplete({}, GAP_PROBE_BOUND_MS);
    });

    // #3374 ask 2 — PROMOTED from the fix-shaped it.fails gap probe: the
    // stale-reclaim release no longer iterates only perChatTurnQueues. shared
    // mode's wedged turn pins the ONE global TurnQueue, and the release now
    // reaches it through the lane's own observable — the published
    // currentRuntimeTurnContext, matched to the reclaimed row by inboundSeq —
    // rejecting that turn's runtime completion and settling the session's
    // provider-turn promise. The queue's ordinary processor-error finalization
    // then recognizes the sweep-owned durable terminal (reclaimed_by_sweep)
    // and advances, so the wedge ends without a restart and afterEach's normal
    // shutdown still succeeds.
    it('cell 7 reclamation gap probe: durable reclamation also releases the wedged SHARED queue (#3374 ask-2 coupling)', async () => {
      const seq = dispatchScheduled();
      await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));

      backdate(seq, '-25 hours');
      expect(engine.sweepStuckInbound()).toMatchObject({ failedStale: 1 });

      await vi.waitFor(() => {
        expect(globalQueue().activeTurn ?? null).toBeNull();
      }, { timeout: GAP_PROBE_BOUND_MS });
    });

    // #3374 C7 — the managed-provider wedge. `reapWedgedProviderChild` returns
    // false when the session holds no local child (`this.child === null`),
    // which is every managed-loop provider: nothing is killed and the remote
    // request is left outstanding. The lane release itself still has to happen
    // (settlement never depended on a child existing), but the operator record
    // must not read as a reap that took place.
    // Call site: releaseWedgedReclaimedGlobalLane, the shared/single mirror.
    it('cell 7 reclamation MANAGED PROVIDER: a shared-lane release that reaped no child says so (#3374 C7)', async () => {
      const seq = dispatchScheduled();
      const session = await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));
      session.reapWedgedProviderChild.mockReturnValue(false);
      await vi.waitFor(() => {
        expect(globalQueue().activeTurn?.sourceMessageId).toMatch(/^agentjob-5-/);
      }, { timeout: 4_000 });

      backdate(seq, '-25 hours');
      expect(engine.sweepStuckInbound()).toMatchObject({ failedStale: 1 });

      // The reap ran and reported that it killed nothing.
      expect(session.reapWedgedProviderChild).toHaveBeenCalledTimes(1);
      expect(wedgeReleaseEvidence()).toContain('reap=reap_skipped_no_child');

      // Release is still unconditional: the lane is freed either way.
      await vi.waitFor(() => {
        expect(globalQueue().activeTurn ?? null).toBeNull();
      }, { timeout: 4_000 });
    });

    // NEGATIVE CONTROL for the record above: a lane whose provider child WAS
    // reaped keeps the reaped wording, so the new detail cannot be a constant
    // and cannot be the release's only spelling.
    it('cell 7 reclamation NEGATIVE: a shared-lane release that DID reap a child is not labelled skipped (#3374 C7 control)', async () => {
      const seq = dispatchScheduled();
      const session = await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));
      session.reapWedgedProviderChild.mockReturnValue(true);
      await vi.waitFor(() => {
        expect(globalQueue().activeTurn?.sourceMessageId).toMatch(/^agentjob-5-/);
      }, { timeout: 4_000 });

      backdate(seq, '-25 hours');
      expect(engine.sweepStuckInbound()).toMatchObject({ failedStale: 1 });

      expect(session.reapWedgedProviderChild).toHaveBeenCalledTimes(1);
      expect(wedgeReleaseEvidence()).toContain('reap=reaped_child');
      expect(wedgeReleaseEvidence()).not.toContain('reap_skipped_no_child');

      await vi.waitFor(() => {
        expect(globalQueue().activeTurn ?? null).toBeNull();
      }, { timeout: 4_000 });
    });

    // NEGATIVE CONTROL for the release above. The 24h grace is NOT the
    // discriminator — a grace-bounded test passes even against a release that
    // fires on any non-empty reclaim batch. So the sweep genuinely reclaims a
    // row (failedStale: 1, the listener runs with a non-empty set) while the
    // wedged scheduled turn stays INSIDE its grace: only the identity match
    // (reclaimed seq === the lane context's inboundSeq) can keep the live turn
    // pinned here.
    it('cell 7 reclamation NEGATIVE: a reclaimed row for a DIFFERENT turn leaves the live shared lane pinned', async () => {
      const seq = dispatchScheduled();
      const session = await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));
      await vi.waitFor(() => {
        expect(globalQueue().activeTurn?.sourceMessageId).toMatch(/^agentjob-5-/);
      }, { timeout: 4_000 });

      // An unrelated stale open inbound in another conversation — never
      // dispatched, so it pins no lane.
      const strangerSeq = engine.journalInbound(
        'msg-unrelated-stale', toConversationKey(otherChatJid), otherChatJid, 'agent',
      );
      backdate(strangerSeq, '-25 hours');
      expect(engine.sweepStuckInbound()).toMatchObject({ failedStale: 1 });
      expect(status(strangerSeq)).toBe('failed');

      // The live turn is untouched: still pinned, still open, provider promise
      // never force-settled.
      expect(globalQueue().activeTurn?.sourceMessageId).toMatch(/^agentjob-5-/);
      expect(session.turnInFlight).toBe(true);
      expect(session.completeProviderTurn).not.toHaveBeenCalled();
      expect(status(seq)).toBe('processing');
    });

    // NEGATIVE CONTROL for the healthy-child interlock. Identity matches on
    // BOTH axes here — the reclaimed row IS this lane's turn — so the seq and
    // conversation-key guards let it through. What must stop the release is the
    // provider-turn-in-flight check: a session whose terminal already arrived
    // has a finalization owner, and releasing would reap a healthy child and
    // reject a turn somebody else is settling.
    it('cell 7 reclamation NEGATIVE: a MATCHING reclaimed row is not released once the provider turn has terminalized', async () => {
      const seq = dispatchScheduled();
      const session = await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));
      await vi.waitFor(() => {
        expect(globalQueue().activeTurn?.sourceMessageId).toMatch(/^agentjob-5-/);
      }, { timeout: 4_000 });

      reportProviderTurnTerminalized(session);
      const rejectSpy = spyOnTurnCompletionRejection();

      backdate(seq, '-25 hours');
      expect(engine.sweepStuckInbound()).toMatchObject({ failedStale: 1 });

      // Nothing the release does happened: no announcement, no child reap, no
      // completion rejection (hence no WedgedTurnReclaimedError constructed),
      // no forced provider-turn settle — and the lane is untouched.
      expect(wedgeReleaseAlerts()).toHaveLength(0);
      expect(session.reapWedgedProviderChild).not.toHaveBeenCalled();
      expect(rejectSpy).not.toHaveBeenCalled();
      expect(session.completeProviderTurn).not.toHaveBeenCalled();
      expect(globalQueue().activeTurn?.sourceMessageId).toMatch(/^agentjob-5-/);
      expect(session.turnInFlight).toBe(true);
    });

    // NEGATIVE CONTROL for the session-ownership guard: the reclaimed row and
    // the lane agree on identity, but the live session is no longer the one the
    // turn context was minted against (a recycled session). Releasing would
    // reject a context a dead generation owns.
    it('cell 7 reclamation NEGATIVE: a MATCHING reclaimed row is not released when session ownership is stale', async () => {
      const seq = dispatchScheduled();
      const session = await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));
      await vi.waitFor(() => {
        expect(globalQueue().activeTurn?.sourceMessageId).toMatch(/^agentjob-5-/);
      }, { timeout: 4_000 });

      (runtime as unknown as { sessionManagerIds: WeakMap<object, string> })
        .sessionManagerIds.set(session as unknown as object, 'superseded-manager-id');
      const rejectSpy = spyOnTurnCompletionRejection();

      backdate(seq, '-25 hours');
      expect(engine.sweepStuckInbound()).toMatchObject({ failedStale: 1 });

      expect(wedgeReleaseAlerts()).toHaveLength(0);
      expect(rejectSpy).not.toHaveBeenCalled();
      expect(session.completeProviderTurn).not.toHaveBeenCalled();
      expect(globalQueue().activeTurn?.sourceMessageId).toMatch(/^agentjob-5-/);
    });
  });

  // ─── single mode — direct dispatch serialized on the turn chain ───────────

  describe('single', () => {
    beforeEach(() => {
      makeRuntime({ sessionScope: 'single' });
    });

    // Single mode has no TurnQueue: every turn chains on this.turnChain and
    // handleMessage's tracking promise resolves as soon as the turn is CHAINED,
    // so the chain's own settlement is the lane observable.
    async function turnChainState(boundMs: number): Promise<'settled' | 'pending'> {
      const chain = (runtime as unknown as { turnChain: Promise<void> }).turnChain;
      return Promise.race([
        chain.then(() => 'settled' as const, () => 'settled' as const),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), boundMs)),
      ]);
    }

    it('cells 1-6: scheduled turn settles durably on the turn chain and a subsequent interactive turn completes', async () => {
      const seq = dispatchScheduled();
      const session = await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));

      emitMidTurnToolDelivery(session);
      expect(session.turnInFlight).toBe(true);
      expect(status(seq)).toBe('processing');

      emitTerminal(session);
      await vi.waitFor(() => expect(status(seq)).toBe('complete'), { timeout: 4_000 });

      // Cell 5 analogue: the turn chain settles within a bound.
      expect(await turnChainState(2_000)).toBe('settled');

      await driveInteractiveToComplete();
    });

    it('cell 7 (negative): withheld provider terminal wedges the turn chain — the stuck turn is observable and a subsequent interactive turn is bounded behind it', async () => {
      const seq = dispatchScheduled();
      const session = await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));

      const messageId = 'msg-interactive-wedged-single';
      const iSeq = engine.journalInbound(messageId, toConversationKey(groupJid), groupJid, 'agent');
      void runtime.handleMessage(makeMsg({ messageId, inboundSeq: iSeq }));

      // The interactive turn chains behind the wedged scheduled turn: the turn
      // chain cannot settle, the interactive turn never reaches the provider,
      // and both journal rows stay open.
      expect(await turnChainState(500)).toBe('pending');
      expect(session.turnsSent).toHaveLength(1);
      expect(status(seq)).toBe('processing');
      expect(status(iSeq)).toBe('processing');

      // Recovery once the terminal finally arrives.
      emitTerminal(session);
      await vi.waitFor(() => {
        expect(session.turnsSent).toHaveLength(2);
        expect(session.turnInFlight).toBe(true);
      }, { timeout: 4_000 });
      emitTerminal(session, 'On it.');
      await vi.waitFor(() => expect(status(iSeq)).toBe('complete'), { timeout: 4_000 });
    });

    // OPEN GAP (#3374): single mode has NO scheduled/interactive isolation on
    // main — the #3341 port routes scheduled jobs to an isolated session/queue
    // only in non-sandbox per_chat mode, the same shape as shared mode (proven
    // above). This probe asserts the DESIRED isolation; it.fails keeps it green
    // only while the gap exists.
    it.fails('cell 7 isolation gap probe: interactive turn completes while a scheduled terminal is withheld (no single-mode isolation on main)', async () => {
      dispatchScheduled();
      await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));
      await driveInteractiveToComplete({}, GAP_PROBE_BOUND_MS);
    });

    // #3374 ask 2 — PROMOTED from the fix-shaped it.fails gap probe: single
    // mode still has no TurnQueue, so the release reaches the lane through the
    // published currentRuntimeTurnContext instead, matched to the reclaimed row
    // by inboundSeq. Rejecting that turn's runtime completion unpins
    // sendTurnNonShared, and handleMessage's turn-chain catch settles the
    // chain. That catch recognizes the release as a DESIGNED settlement: the
    // sweep keeps durable ownership (failure_class stays 'stale_reclaim', so no
    // second terminal was written) and no user-facing failure notice is sent —
    // for a scheduled job that notice would land in the report chat a day late.
    it('cell 7 reclamation gap probe: durable reclamation also settles the wedged turn chain (#3374 ask-2 coupling)', async () => {
      const seq = dispatchScheduled();
      await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));

      backdate(seq, '-25 hours');
      expect(engine.sweepStuckInbound()).toMatchObject({ failedStale: 1 });

      expect(await turnChainState(GAP_PROBE_BOUND_MS)).toBe('settled');
      expect(failureClass(seq)).toBe('stale_reclaim');
      expect(directSendTexts()).not.toContain(PROCESSING_FAILURE_NOTICE);
    });

    // NEGATIVE CONTROL for the release above — same shape as shared's: the
    // sweep genuinely reclaims a row (so the release listener runs with a
    // non-empty set) while the wedged turn stays inside its grace. Only the
    // identity match keeps the live turn pinned.
    it('cell 7 reclamation NEGATIVE: a reclaimed row for a DIFFERENT turn leaves the live turn chain pinned', async () => {
      const seq = dispatchScheduled();
      const session = await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));

      const strangerSeq = engine.journalInbound(
        'msg-unrelated-stale-single', toConversationKey(otherChatJid), otherChatJid, 'agent',
      );
      backdate(strangerSeq, '-25 hours');
      expect(engine.sweepStuckInbound()).toMatchObject({ failedStale: 1 });
      expect(status(strangerSeq)).toBe('failed');

      expect(await turnChainState(GAP_PROBE_BOUND_MS)).toBe('pending');
      expect(session.turnInFlight).toBe(true);
      expect(session.completeProviderTurn).not.toHaveBeenCalled();
      expect(status(seq)).toBe('processing');
    });

    // NEGATIVE CONTROL for the healthy-child interlock, single-scope twin of
    // the shared case: identity matches on both axes, so only the
    // provider-turn-in-flight check can stop the release.
    it('cell 7 reclamation NEGATIVE: a MATCHING reclaimed row is not released once the provider turn has terminalized', async () => {
      const seq = dispatchScheduled();
      const session = await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));

      reportProviderTurnTerminalized(session);
      const rejectSpy = spyOnTurnCompletionRejection();

      backdate(seq, '-25 hours');
      expect(engine.sweepStuckInbound()).toMatchObject({ failedStale: 1 });

      expect(wedgeReleaseAlerts()).toHaveLength(0);
      expect(session.reapWedgedProviderChild).not.toHaveBeenCalled();
      expect(rejectSpy).not.toHaveBeenCalled();
      expect(session.completeProviderTurn).not.toHaveBeenCalled();
      expect(await turnChainState(GAP_PROBE_BOUND_MS)).toBe('pending');
      expect(session.turnInFlight).toBe(true);
    });
  });

  // ─── sandbox per-chat — workspace-scoped sessions, scheduled NOT isolated ─

  describe('per_chat (sandbox)', () => {
    beforeEach(() => {
      makeRuntime({ sessionScope: 'per_chat', sandboxPerChat: true });
    });

    function queueFor(mapKey: string): TurnQueue | undefined {
      return (runtime as unknown as { perChatTurnQueues: Map<string, TurnQueue> })
        .perChatTurnQueues.get(mapKey);
    }

    // resolveAgentTurnMapKey applies only when !sandboxPerChat (runtime.ts):
    // in sandbox mode the scheduled turn shares the chat's workspace lane.
    const workspaceKey = 'test-scheduled-group';

    it('cells 1-6: scheduled turn settles durably on the workspace lane and a subsequent interactive turn completes', async () => {
      const seq = dispatchScheduled();
      const session = await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));

      emitMidTurnToolDelivery(session);
      expect(session.turnInFlight).toBe(true);
      expect(queueFor(workspaceKey)?.activeTurn?.sourceMessageId).toMatch(/^agentjob-5-/);
      expect(status(seq)).toBe('processing');

      emitTerminal(session);
      await vi.waitFor(() => expect(status(seq)).toBe('complete'), { timeout: 4_000 });

      await vi.waitFor(() => {
        expect(queueFor(workspaceKey)?.activeTurn ?? null).toBeNull();
        expect(queueFor(workspaceKey)?.pending ?? 0).toBe(0);
      }, { timeout: 4_000 });

      await driveInteractiveToComplete();
    });

    it('cell 7 (negative): withheld provider terminal wedges the workspace lane; a DIFFERENT chat still completes (cross-chat isolation)', async () => {
      const seq = dispatchScheduled();
      const session = await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));

      // The wedge is observable on the shared workspace lane.
      await vi.waitFor(() => {
        expect(queueFor(workspaceKey)?.activeTurn?.sourceMessageId).toMatch(/^agentjob-5-/);
      }, { timeout: 4_000 });
      expect(status(seq)).toBe('processing');

      // Cross-chat isolation holds: an interactive turn in another chat completes.
      await driveInteractiveToComplete({ chatJid: otherChatJid, isGroup: false });

      // The wedged workspace lane is untouched by the other chat's completion.
      expect(session.turnInFlight).toBe(true);
      expect(queueFor(workspaceKey)?.activeTurn?.sourceMessageId).toMatch(/^agentjob-5-/);
      expect(status(seq)).toBe('processing');
    });

    // OPEN GAP (#3374): the #3341 isolation port is explicitly scoped to
    // NON-sandbox per_chat mode — in sandbox mode a scheduled job shares the
    // chat's workspace session/queue, so a withheld scheduled terminal blocks
    // the SAME chat's interactive turns. This probe asserts the DESIRED
    // same-chat isolation; it.fails keeps it green only while the gap exists.
    it.fails('cell 7 isolation gap probe: same-chat interactive turn completes while a scheduled terminal is withheld (scheduled jobs share the workspace lane on main)', async () => {
      dispatchScheduled();
      await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));
      await driveInteractiveToComplete({}, GAP_PROBE_BOUND_MS);
    });

    // #3374 ask 2 in SANDBOX mode: the scheduled turn rides the chat's
    // workspace lane, which lives in perChatTurnQueues — the exact map the
    // stale-reclaim release iterates — so the ask-2 coupling covers sandbox
    // mode too (unlike shared/single, whose lanes the release cannot reach).
    it('cell 7 reclamation: durable reclamation also releases the wedged workspace lane (#3374 ask-2 coupling)', async () => {
      const seq = dispatchScheduled();
      await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));
      await vi.waitFor(() => {
        expect(queueFor(workspaceKey)?.activeTurn?.sourceMessageId).toMatch(/^agentjob-5-/);
      }, { timeout: 4_000 });

      backdate(seq, '-25 hours');
      expect(engine.sweepStuckInbound()).toMatchObject({ failedStale: 1 });

      await vi.waitFor(() => {
        expect(queueFor(workspaceKey)?.activeTurn ?? null).toBeNull();
      }, { timeout: 4_000 });
    });
  });

  // ─── FLOS Stage 1 emission (plan §3) — the runtime emission seams ─────────

  describe('FLOS Stage 1 lifecycle emission', () => {
    let captured: LifecycleEmitInput[];

    beforeEach(() => {
      captured = [];
      __setRuntimeLifecycleEmitterForTests({
        enabled: true,
        bootId: 'boot-test',
        emit: (input) => {
          captured.push(input);
          return true;
        },
        close: () => {},
      });
      makeRuntime({ sessionScope: 'per_chat' });
    });

    afterEach(() => {
      __setRuntimeLifecycleEmitterForTests(null);
    });

    it('a scheduled turn emits one L-SCH chain under its synthetic message id: admitted → dispatched → acknowledged → terminal_result → finalized', async () => {
      const seq = dispatchScheduled('Check for a scholarship reply.', 23);
      const session = await waitForInFlightTurn((t) => t.includes(SCHEDULED_PROMPT_MARK));
      emitMidTurnToolDelivery(session);
      emitTerminal(session);
      await vi.waitFor(() => {
        expect(captured.map((e) => e.phase)).toContain('finalized');
      }, { timeout: 4_000 });

      const schEvents = captured.filter((e) => e.lane === 'L-SCH');
      expect(new Set(schEvents.map((e) => e.work_id)).size).toBe(1);
      expect(schEvents.map((e) => e.phase)).toEqual([
        'admitted', 'dispatched', 'acknowledged', 'terminal_result', 'finalized',
      ]);
      // Every event in the chain joins to its trigger_occurrences row (#2566).
      for (const event of schEvents) {
        expect(event.correlation?.['trigger_occurrence_id']).toBe('23');
      }
      expect(schEvents[0]!.correlation?.['inbound_seq']).toBe(seq);
    });

    it('an interactive turn emits L-INT admitted, terminal_result, and finalized under its inbound message id', async () => {
      await driveInteractiveToComplete({ messageId: 'msg-flos-int-1' });
      const intEvents = captured.filter((e) => e.lane === 'L-INT' && e.work_id === 'msg-flos-int-1');
      const phases = intEvents.map((e) => e.phase);
      expect(phases[0]).toBe('admitted');
      expect(phases).toContain('terminal_result');
      expect(phases[phases.length - 1]).toBe('finalized');
    });
  });
});
