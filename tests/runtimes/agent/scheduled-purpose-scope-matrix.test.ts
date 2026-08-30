// #3427 SCOPE MATRIX — a scheduled agent job (isSyntheticJob=true, admin JID)
// must reach the registry's forbidden-tools gate with purpose
// 'scheduled-agent-job' in EVERY scope, not only per_chat (where the
// ::scheduled-agent-job mapKey suffix already sets it). The defect: single,
// shared, AND sandboxPerChat never set purpose, so the gate was inert and a
// scheduled job could call edit_message/delete_message/delete_chat.
//
// Harness: REAL AgentRuntime + REAL coordinator; provider boundary faked
// (global-actor-scoping / scheduled-turn-lifecycle pattern). The socket-server
// module mock captures the constructor's purposeResolver (#3427 arg 5) and the
// updatePurpose broadcast spy so each row observes the production purpose signal
// and feeds it through a REAL ToolRegistry + the REAL gate + the REAL forbidden
// tool name. The per_chat row is a CONTROL (green before and after): its sender
// rides its own actor-bound socket and its purpose is static/suffix-derived, so
// the global register never carries it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import type { Messenger, IncomingMessage } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import { toConversationKey, GLOBAL_CONVERSATION_KEY } from '../../../src/core/conversation-key.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import type { ExecActorSlot } from '../../../src/runtimes/agent/exec-actor-slot.ts';

// ─── Hoisted provider-boundary doubles ──────────────────────────────────────

const { sessionDoubles, queueDoubles, resetDoubles, makeSessionDouble, makeQueueDouble, socketServers } = vi.hoisted(() => {
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
      turnsSent: [] as unknown[],
      get turnInFlight(): boolean {
        return pendingResolve !== null;
      },
      emit(event: AgentEvent): void {
        opts.onEvent(event);
      },
      spawnSession: vi.fn(async () => {
        active = true;
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
      getProviderId: vi.fn(() => 'claude-cli'),
      getModelRef: vi.fn(() => undefined),
    };
    return double;
  }

  function makeQueueDouble(chatJid: string) {
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
        turnId, answerOpIds: [], lifecycleOpIds: [], statusOpIds: [],
      })),
      setToolUpdateMode: vi.fn(),
      setToolUpdateRedirectJid: vi.fn(),
      setTextAggregateDelayMs: vi.fn(),
      enqueuePoll: vi.fn(async (fn: () => Promise<void>) => { await fn(); }),
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
  /** Every WhatSoupSocketServer construction: tier + captured resolvers + spies. */
  const socketServers: Array<{
    session: { tier?: string };
    actorResolver: (() => string | undefined) | undefined;
    purposeResolver: (() => SessionContext['purpose']) | undefined;
    updateActorJid: ReturnType<typeof vi.fn>;
    updatePurpose: ReturnType<typeof vi.fn>;
  }> = [];

  function resetDoubles(): void {
    sessionDoubles.length = 0;
    queueDoubles.length = 0;
    socketServers.length = 0;
  }

  return { sessionDoubles, queueDoubles, resetDoubles, makeSessionDouble, makeQueueDouble, socketServers };
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
    stateRoot: `/tmp/whatsoup-test-state-sched-purpose-${process.pid}`,
    restartLoopGuard: { enabled: true, maxRestarts: 3, windowMs: 300_000 },
    startupNotifications: false,
    proactiveResumeOnStartup: false,
    mediaDir: `/tmp/whatsoup-test-media-sched-purpose-${process.pid}`,
    pineconeAllowedIndexes: [] as string[],
    voiceReply: 'never' as const,
    elevenlabs: { defaultVoiceId: 'v', defaultModel: 'm', stability: 0.5, similarityBoost: 0.75 },
    memory: { adminJid: 'admin@s.whatsapp.net' },
  },
}));

// #3427 S4: capture the resolvePurpose (arg 4) the runtime passes to
// createProviderMcpBridge (runtime.ts ~9420), so the bridge-surface wiring is
// asserted through the real runtime, not only the bridge unit test.
const { bridgeCaptures } = vi.hoisted(() => ({
  bridgeCaptures: [] as Array<(() => SessionContext['purpose']) | undefined>,
}));

// ─── Module mocks (mirror global-actor-scoping.test.ts) ──────────────────────

vi.mock('../../../src/logger.ts', async () => {
  const { loggerMock } = await import('../../helpers/logger-mock.ts');
  return loggerMock();
});

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlert: vi.fn(), emitAlertChecked: vi.fn(), emitObservationChecked: vi.fn(() => true),
  clearAlertSource: vi.fn(), clearAlertSourceChecked: vi.fn(),
}));

vi.mock('../../../src/core/messages.ts', () => ({
  getRecentMessages: vi.fn(() => []), getMessagesSince: vi.fn(() => []),
  updateMediaPath: vi.fn(), updateTranscription: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/media-prep.ts', () => ({
  prepareContentForAgent: vi.fn(async (msg: IncomingMessage) => msg.content ?? ''),
  relocateMediaToWorkspace: vi.fn((content: string) => content),
}));

vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  ensureAgentSchema: vi.fn(), createSession: vi.fn(() => 1), accumulateSessionTokens: vi.fn(),
  incrementMessageCount: vi.fn(), updateSessionId: vi.fn(), updateSessionStatus: vi.fn(),
  getActiveSession: vi.fn(() => null), backfillWorkspaceKeys: vi.fn(), markOrphaned: vi.fn(),
  getResumableSessionForChat: vi.fn(() => null), backfillSessionProvider: vi.fn(),
  accumulateTokensWithEvent: vi.fn(), insertTokenEvent: vi.fn(),
  getSessionTokenSnapshot: vi.fn(() => null), markSessionCompacted: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/session-classifier.ts', () => ({
  classifyActiveSessions: vi.fn(() => []),
}));

vi.mock('../../../src/runtimes/agent/session.ts', () => ({
  // eslint-disable-next-line prefer-arrow-callback -- constructor mock requires function keyword; expires 2026-12-31
  SessionManager: vi.fn().mockImplementation(function (opts: {
    chatJid: string; persistenceConversationKey?: string; onEvent: (event: AgentEvent) => void;
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
  OutboundQueue: vi.fn().mockImplementation(function (_messenger: unknown, chatJid: string) {
    const double = makeQueueDouble(chatJid);
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
  WhatSoupSocketServer: vi.fn().mockImplementation(function (
    _socketPath: string,
    _registry: unknown,
    session: { tier?: string },
    actorResolver?: () => string | undefined,
    purposeResolver?: () => SessionContext['purpose'],
  ) {
    const instance = {
      session, actorResolver, purposeResolver,
      start: vi.fn(), stop: vi.fn(),
      updateDeliveryJid: vi.fn(), updateActorJid: vi.fn(),
      updatePurpose: vi.fn(), updateConversationKey: vi.fn(),
    };
    socketServers.push(instance as unknown as (typeof socketServers)[number]);
    return instance;
  }),
}));

vi.mock('../../../src/mcp/register-all.ts', () => ({ registerAllTools: vi.fn() }));

// #3427 S4: wrap the REAL createProviderMcpBridge, capturing arg 4
// (resolvePurpose) so the runtime's bridge wiring is asserted end-to-end.
vi.mock('../../../src/runtimes/agent/providers/mcp-bridge.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtimes/agent/providers/mcp-bridge.ts')>();
  return {
    ...actual,
    createProviderMcpBridge: vi.fn((
      registry: Parameters<typeof actual.createProviderMcpBridge>[0],
      session: Parameters<typeof actual.createProviderMcpBridge>[1],
      resolveActor?: Parameters<typeof actual.createProviderMcpBridge>[2],
      resolvePurpose?: Parameters<typeof actual.createProviderMcpBridge>[3],
    ) => {
      bridgeCaptures.push(resolvePurpose);
      return actual.createProviderMcpBridge(registry, session, resolveActor, resolvePurpose);
    }),
  };
});

vi.mock('../../../src/runtimes/agent/media-bridge.ts', () => ({
  startMediaBridge: vi.fn(() => null), setMediaBridgeChat: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn() };
});

// ─── Imports under test (after mocks) ───────────────────────────────────────

import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import { AgentRuntime, type AgentRuntimeOptions } from '../../../src/runtimes/agent/runtime.ts';
import { ToolRegistry, SCHEDULED_AGENT_JOB_FORBIDDEN_TOOLS } from '../../../src/mcp/registry.ts';
import { installFakePerChatMcpSocketManager } from './helpers/fake-per-chat-mcp-socket-manager.ts';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const chatJid = '15550002@s.whatsapp.net';
const ADMIN_JID = 'admin@s.whatsapp.net';
const FORBIDDEN_TOOL = 'delete_message';
const SCHEDULED = 'scheduled-agent-job' as const;

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: `msg-${Math.random().toString(36).slice(2, 8)}`,
    chatJid,
    senderJid: ADMIN_JID,
    senderName: 'Scheduled job',
    content: 'scheduled work',
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

function turnText(input: unknown): string {
  if (typeof input === 'string') return input;
  const structured = input as { userText?: string; applicationContext?: readonly string[] };
  return [structured.applicationContext?.join('\n') ?? '', structured.userText ?? ''].join('\n');
}

type SessionDouble = (typeof sessionDoubles)[number];

async function waitForInFlightTurn(matcher: (text: string) => boolean, timeout = 4_000): Promise<SessionDouble> {
  let found: SessionDouble | undefined;
  await vi.waitFor(() => {
    found = sessionDoubles.find((s) => s.turnInFlight && s.turnsSent.some((t) => matcher(turnText(t))));
    expect(found).toBeDefined();
  }, { timeout });
  return found!;
}

/** REAL registry + REAL gate + REAL forbidden-set tool name — the reachability
 *  oracle every row feeds its captured production purpose signal into. Returns
 *  'denied' (gate engaged) or 'reachable' (gate inert). */
function makeForbiddenRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: FORBIDDEN_TOOL,
    description: 'Delete a message (forbidden to scheduled jobs).',
    scope: 'chat',
    targetMode: 'caller-supplied',
    schema: z.object({}),
    handler: async () => ({ reached: true }),
  });
  return registry;
}

async function reachability(purpose: SessionContext['purpose']): Promise<'denied' | 'reachable'> {
  const registry = makeForbiddenRegistry();
  const result = await registry.call(
    FORBIDDEN_TOOL, {},
    { tier: 'global', actorJid: ADMIN_JID, conversationKey: 'c', purpose },
  );
  if (result.isError && result.content[0]?.text === `Unknown tool: ${FORBIDDEN_TOOL}`) return 'denied';
  return 'reachable';
}

describe('#3427 scheduled-agent-job purpose — scope matrix', () => {
  let db: Database;
  let engine: DurabilityEngine;
  let runtime: AgentRuntime;

  function globalSocket() {
    return socketServers.find((s) => s.session?.tier === 'global');
  }
  function chatScopedSocket() {
    return socketServers.find((s) => s.session?.tier === 'chat-scoped');
  }
  /** Direct read of the executing-turn register — the slot the publish site
   *  actually wrote, independent of the read-time resolver. single/shared publish
   *  under GLOBAL_TOOL_SCOPE_KEY (= GLOBAL_CONVERSATION_KEY). */
  function execSlotHead(): ExecActorSlot | undefined {
    return (runtime as unknown as { perChatExecActorQueue: Map<string, ExecActorSlot[]> })
      .perChatExecActorQueue.get(GLOBAL_CONVERSATION_KEY)?.[0];
  }

  function makeRuntime(options: AgentRuntimeOptions): void {
    runtime = new AgentRuntime(db, makeMessenger(), 'test', options);
    installFakePerChatMcpSocketManager(runtime);
    runtime.setDurability(engine);
  }

  async function arriveJob(overrides: Partial<IncomingMessage> = {}): Promise<void> {
    const messageId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const targetJid = (overrides.chatJid as string | undefined) ?? chatJid;
    const seq = engine.journalInbound(messageId, toConversationKey(targetJid), targetJid, 'agent');
    void runtime.handleMessage(makeMsg({ isSyntheticJob: true, ...overrides, messageId, chatJid: targetJid, inboundSeq: seq }));
  }

  async function drainInFlight(): Promise<void> {
    for (const session of sessionDoubles) {
      if (session.turnInFlight) session.emit({ type: 'result', text: 'done' });
    }
    await (runtime as unknown as { turnChain?: Promise<void> }).turnChain;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetDoubles();
    bridgeCaptures.length = 0;
    db = new Database(':memory:');
    db.open();
    engine = new DurabilityEngine(db);
  });

  afterEach(async () => {
    for (const session of sessionDoubles) {
      if (session.turnInFlight) session.emit({ type: 'result', text: 'late' });
    }
    await runtime?.shutdown();
    db.close();
  });

  // ── Positive control: the gate is live and imported, and delete_message is a
  //    real forbidden-set member. A row failing below is therefore a WIRING red. ─
  it('POSITIVE CONTROL: the real gate denies delete_message iff purpose is scheduled-agent-job', async () => {
    expect(SCHEDULED_AGENT_JOB_FORBIDDEN_TOOLS.has(FORBIDDEN_TOOL)).toBe(true);
    expect(await reachability(SCHEDULED)).toBe('denied');
    expect(await reachability(undefined)).toBe('reachable');
  });

  it('SHARED scope: the shared-dispatch publish (processTurn) writes purpose to the global slot → forbidden tool DENIED', async () => {
    // Shared scope dispatches via enqueueSharedRuntimeTurn → the global turn
    // queue → processTurn, which publishes {actorJid, purpose:turn.isSyntheticJob}
    // (runtime.ts ~5086). This row exercises THAT path.
    makeRuntime({ sessionScope: 'shared' });
    await runtime.start();

    await arriveJob();
    await waitForInFlightTurn((t) => t.includes('scheduled work'));

    // The publish site itself wrote the purpose into the slot (RED here on the
    // unfixed base: the slot holds a bare actor string / no purpose → reachable).
    const slot = execSlotHead();
    expect(slot?.purpose).toBe(SCHEDULED);
    expect(await reachability(slot?.purpose)).toBe('denied');

    // And the read-time resolver exposes it to the socket (single/shared wiring).
    const resolver = globalSocket()?.purposeResolver;
    expect(resolver?.()).toBe(SCHEDULED);
    expect(await reachability(resolver?.())).toBe('denied');

    await drainInFlight();
    await vi.waitFor(() => { expect(resolver?.()).toBeUndefined(); }, { timeout: 4_000 });
  });

  it('SINGLE scope: the non-shared publish (sendTurnNonShared → sendTurnToSession) writes purpose to the global slot → forbidden tool DENIED', async () => {
    // Single scope dispatches via sendTurnNonShared → sendTurnToSession, which
    // publishes {actorJid, purpose} from the threaded isScheduledAgentJob flag
    // (runtime.ts ~5309). This row exercises THAT distinct path — single has no
    // mapKey suffix, so the flag threaded from msg.isSyntheticJob is load-bearing.
    makeRuntime({ sessionScope: 'single' });
    await runtime.start();

    await arriveJob();
    await waitForInFlightTurn((t) => t.includes('scheduled work'));

    const slot = execSlotHead();
    expect(slot?.purpose).toBe(SCHEDULED);
    expect(await reachability(slot?.purpose)).toBe('denied');

    const resolver = globalSocket()?.purposeResolver;
    expect(resolver).toBeDefined();

    const midPurpose = resolver!();
    expect(midPurpose).toBe(SCHEDULED);
    expect(await reachability(midPurpose)).toBe('denied');
  });

  it('S4 bridge (single/shared): the runtime wires resolveBridgePurpose into createProviderMcpBridge → forbidden tool DENIED', async () => {
    // Managed-loop providers serve tools through the in-process bridge, not the
    // socket. This row asserts the runtime passes a working purpose resolver as
    // createProviderMcpBridge arg 4 (runtime.ts ~9420) — the bridge surface the
    // socket rows do not exercise. resolveBridgePurpose delegates to the same
    // global register the socket resolver reads, so a scheduled job resolves to
    // 'scheduled-agent-job' mid-turn.
    makeRuntime({ sessionScope: 'single' });
    await runtime.start();

    await arriveJob();
    await waitForInFlightTurn((t) => t.includes('scheduled work'));

    const resolvePurpose = bridgeCaptures.at(-1);
    expect(resolvePurpose).toBeDefined(); // wiring: bridge arg 4 present
    const midPurpose = resolvePurpose!();
    expect(midPurpose).toBe(SCHEDULED);
    expect(await reachability(midPurpose)).toBe('denied');
  });

  it('SINGLE scope: a NORMAL turn leaves purpose undefined → forbidden tool REACHABLE (no over-restriction)', async () => {
    makeRuntime({ sessionScope: 'single' });
    await runtime.start();

    const resolver = globalSocket()?.purposeResolver;
    expect(resolver).toBeDefined();

    // A normal (non-synthetic) turn.
    const messageId = `norm-${Date.now()}`;
    const seq = engine.journalInbound(messageId, toConversationKey(chatJid), chatJid, 'agent');
    void runtime.handleMessage(makeMsg({ isSyntheticJob: false, senderJid: '15559999@s.whatsapp.net', messageId, inboundSeq: seq, content: 'normal turn' }));
    await waitForInFlightTurn((t) => t.includes('normal turn'));

    const midPurpose = resolver!();
    expect(midPurpose).toBeUndefined();
    expect(await reachability(midPurpose)).toBe('reachable');
  });

  it('SANDBOX per-chat: a scheduled job broadcasts purpose to its workspace socket → forbidden tool DENIED', async () => {
    makeRuntime({ sessionScope: 'single', sandboxPerChat: true });
    await runtime.start();

    await arriveJob();

    // The sandbox path broadcasts updatePurpose per message before dispatch.
    await vi.waitFor(() => {
      const sock = chatScopedSocket();
      expect(sock).toBeDefined();
      expect(sock!.updatePurpose).toHaveBeenCalled();
    }, { timeout: 4_000 });

    const sock = chatScopedSocket()!;
    // The global socket is not created in sandbox mode; purpose rides the
    // broadcast, resolved from the connection session (no purposeResolver).
    expect(sock.purposeResolver).toBeUndefined();
    const broadcast = sock.updatePurpose.mock.calls.at(-1)?.[0] as SessionContext['purpose'];
    expect(broadcast).toBe(SCHEDULED);
    expect(await reachability(broadcast)).toBe('denied');
  });

  it('SANDBOX per-chat: a NORMAL turn broadcasts undefined → forbidden tool REACHABLE', async () => {
    makeRuntime({ sessionScope: 'single', sandboxPerChat: true });
    await runtime.start();

    const messageId = `norm-${Date.now()}`;
    const seq = engine.journalInbound(messageId, toConversationKey(chatJid), chatJid, 'agent');
    void runtime.handleMessage(makeMsg({ isSyntheticJob: false, senderJid: '15559999@s.whatsapp.net', messageId, inboundSeq: seq, content: 'normal turn' }));

    await vi.waitFor(() => {
      const sock = chatScopedSocket();
      expect(sock).toBeDefined();
      expect(sock!.updatePurpose).toHaveBeenCalled();
    }, { timeout: 4_000 });

    const broadcast = chatScopedSocket()!.updatePurpose.mock.calls.at(-1)?.[0] as SessionContext['purpose'];
    expect(broadcast).toBeUndefined();
    expect(await reachability(broadcast)).toBe('reachable');
  });

  it('CONTROL — per_chat: the global register never exposes a per-chat scheduled job (rides its own suffixed socket)', async () => {
    makeRuntime({ sessionScope: 'per_chat' });
    await runtime.start();

    const resolver = globalSocket()?.purposeResolver;
    expect(resolver).toBeDefined();
    expect(resolver!()).toBeUndefined();

    await arriveJob();
    await waitForInFlightTurn((t) => t.includes('scheduled work'));
    // per_chat purpose is static/suffix-derived on the dedicated per-chat socket
    // (covered by per-chat-actor tests); the shared global resolver stays empty.
    expect(resolver!()).toBeUndefined();
  });
});
