// #2976 residual — runtime wiring for the in-process provider MCP bridge.
//
// #3389 gave the GLOBAL SOCKET a read-time actor resolver over the
// executing-turn register (perChatExecActorQueue). Managed-loop (API) providers
// never use that socket — they serve WhatSoup tools through the in-process
// bridge (createProviderMcpBridge) — so they were left reading the stored MCP
// session context's actorJid, which was set per turn and never cleared. This
// suite proves, through a REAL AgentRuntime + REAL coordinator (provider
// boundary faked, same pattern as global-actor-scoping.test.ts):
//
//   1. the runtime wires the bridge with a resolver that exposes the executing
//      turn's sender mid-turn and undefined between turns (shared scope);
//   2. the SAME holds for a per_chat managed-loop session — which required
//      publishing the managed-loop actor into the per-chat register (the socket
//      path never did, because API providers have no socket);
//   3. the stored MCP conduit (mcpSessionContext.actorJid) is populated at
//      dispatch and CLEARED at turn end, so it cannot linger between turns.
//
// The bridge captured from the session is the REAL bridge with the REAL
// resolver; a probe tool registered on the runtime's registry records the
// actorJid the bridge hands the registry per call.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import type { Messenger, IncomingMessage } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import type { ProviderMcpBridge } from '../../../src/runtimes/agent/providers/types.ts';
import { toConversationKey } from '../../../src/core/conversation-key.ts';

// ─── Hoisted provider-boundary doubles ──────────────────────────────────────

const { sessionDoubles, queueDoubles, resetDoubles, makeSessionDouble, makeQueueDouble, providerForDouble } = vi.hoisted(() => {
  // Test-controlled provider id for each constructed session double. Managed-loop
  // ids ('anthropic-api'/'openai-api') exercise the in-process-bridge push path.
  const providerForDouble = { value: 'claude-cli' };

  type SessionCtorOpts = {
    chatJid: string;
    persistenceConversationKey?: string;
    mcpBridge?: ProviderMcpBridge;
    mcpSessionContext?: SessionContext;
    onEvent: (event: AgentEvent) => void;
    onCrash?: (info: unknown) => void;
    notifyUser?: (msg: string) => void;
  };

  function makeSessionDouble(opts: SessionCtorOpts) {
    let active = false;
    let pendingResolve: (() => void) | null = null;
    let pendingPromise: Promise<void> = Promise.resolve();
    const providerId = providerForDouble.value;
    const double = {
      ctorOpts: opts,
      // The REAL bridge (with the read-time resolver) the runtime built for this
      // session, and the REAL stored MCP session context it mutates.
      mcpBridge: opts.mcpBridge,
      mcpSessionContext: opts.mcpSessionContext,
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
      // Mirror the real SessionManager conduit primitives so the stored context's
      // lifecycle is observable through this double.
      updateMcpActorJid: vi.fn((jid: string) => {
        if (double.mcpSessionContext) double.mcpSessionContext.actorJid = jid;
      }),
      clearMcpActorJid: vi.fn(() => {
        if (double.mcpSessionContext) double.mcpSessionContext.actorJid = undefined;
      }),
      clearTurnWatchdog: vi.fn(),
      tickWatchdog: vi.fn(),
      trackToolStart: vi.fn(),
      trackToolEnd: vi.fn(),
      getDbRowId: vi.fn((): number | null => 1),
      setDurability: vi.fn(),
      bindGenerationOwnership: vi.fn(),
      getProviderId: vi.fn(() => providerId),
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

  function resetDoubles(): void {
    sessionDoubles.length = 0;
    queueDoubles.length = 0;
    providerForDouble.value = 'claude-cli';
  }

  return { sessionDoubles, queueDoubles, resetDoubles, makeSessionDouble, makeQueueDouble, providerForDouble };
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
    stateRoot: `/tmp/whatsoup-test-state-bridge-actor-${process.pid}`,
    restartLoopGuard: { enabled: true, maxRestarts: 3, windowMs: 300_000 },
    startupNotifications: false,
    proactiveResumeOnStartup: false,
    mediaDir: `/tmp/whatsoup-test-media-bridge-actor-${process.pid}`,
    pineconeAllowedIndexes: [] as string[],
    voiceReply: 'never' as const,
    elevenlabs: { defaultVoiceId: 'v', defaultModel: 'm', stability: 0.5, similarityBoost: 0.75 },
    memory: { adminJid: 'admin@s.whatsapp.net' },
  },
}));

// ─── Module mocks (same surface as global-actor-scoping.test.ts) ─────────────

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
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { isAdminActor, type SubstrateDeps } from '../../../src/mcp/tools/substrate.ts';
import { AgentRuntime, type AgentRuntimeOptions } from '../../../src/runtimes/agent/runtime.ts';
import { installFakePerChatMcpSocketManager } from './helpers/fake-per-chat-mcp-socket-manager.ts';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const chatJid = '15550002@s.whatsapp.net';
const senderJid = '15550001@s.whatsapp.net';

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: `msg-bridge-${Math.random().toString(36).slice(2, 8)}`,
    chatJid,
    senderJid,
    senderName: 'Test User',
    content: 'bridge scoping question',
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
    found = sessionDoubles.find(
      (s) => s.turnInFlight && s.turnsSent.some((t) => matcher(turnText(t))),
    );
    expect(found).toBeDefined();
  }, { timeout });
  return found!;
}

describe('provider-bridge actor scoping (#2976 residual)', () => {
  let db: Database;
  let engine: DurabilityEngine;
  let runtime: AgentRuntime;
  /** actorJid observed by the probe tool per bridge call (read-time snapshot). */
  let observedActors: Array<string | undefined>;

  function makeRuntime(options: AgentRuntimeOptions): void {
    runtime = new AgentRuntime(db, makeMessenger(), 'test', options);
    installFakePerChatMcpSocketManager(runtime);
    runtime.setDurability(engine);
    // register-all is mocked to a noop; register a probe on the runtime's real
    // registry so a bridge call reveals the actorJid the resolver produced.
    const registry = (runtime as unknown as { registry: ToolRegistry }).registry;
    registry.register({
      name: 'actor_probe',
      description: 'Records the session actor the bridge passed at call time',
      scope: 'chat',
      targetMode: 'caller-supplied',
      schema: z.object({}),
      handler: async (_params, session) => {
        observedActors.push(session.actorJid);
        return { actor: session.actorJid ?? null };
      },
    });
  }

  async function arriveMessage(overrides: Partial<IncomingMessage> = {}): Promise<number> {
    const messageId = (overrides.messageId as string | undefined) ?? `msg-bridge-${Date.now()}`;
    const targetJid = (overrides.chatJid as string | undefined) ?? chatJid;
    const seq = engine.journalInbound(messageId, toConversationKey(targetJid), targetJid, 'agent');
    void runtime.handleMessage(makeMsg({ ...overrides, messageId, chatJid: targetJid, inboundSeq: seq }));
    return seq;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetDoubles();
    observedActors = [];
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

  it('shared scope: the bridge resolver exposes the executing sender mid-turn and undefined between turns', async () => {
    providerForDouble.value = 'anthropic-api';
    makeRuntime({ sessionScope: 'shared' });
    await runtime.start();

    await arriveMessage();
    const session = await waitForInFlightTurn((t) => t.includes('bridge scoping question'));
    const bridge = session.mcpBridge;
    expect(bridge).toBeDefined();

    // Mid-turn: the bridge snapshot resolves the executing turn's sender.
    await bridge!.executeTool('actor_probe', {});
    expect(observedActors.at(-1)).toBe(senderJid);
    // And the stored conduit was populated at dispatch.
    expect(session.mcpSessionContext?.actorJid).toBe(senderJid);

    session.emit({ type: 'result', text: 'done' });
    await (runtime as unknown as { turnChain: Promise<void> }).turnChain;

    // Between turns: the register is retired → resolver denies (undefined), and
    // the stored conduit is cleared (no lingering sender).
    await vi.waitFor(() => {
      expect(session.mcpSessionContext?.actorJid).toBeUndefined();
    }, { timeout: 4_000 });
    await bridge!.executeTool('actor_probe', {});
    expect(observedActors.at(-1)).toBeUndefined();
  });

  it('per_chat managed-loop: the bridge resolver exposes the sender mid-turn (register push) and undefined between turns', async () => {
    providerForDouble.value = 'anthropic-api';
    makeRuntime({ sessionScope: 'per_chat' });
    await runtime.start();

    await arriveMessage();
    const session = await waitForInFlightTurn((t) => t.includes('bridge scoping question'));
    const bridge = session.mcpBridge;
    expect(bridge).toBeDefined();

    // Mid-turn: without publishing the managed-loop actor into the per-chat
    // register this resolves to undefined — the no-regression pin the push fixes.
    await bridge!.executeTool('actor_probe', {});
    expect(observedActors.at(-1)).toBe(senderJid);
    expect(session.mcpSessionContext?.actorJid).toBe(senderJid);

    session.emit({ type: 'result', text: 'done' });
    await (runtime as unknown as { turnChain: Promise<void> }).turnChain;

    await vi.waitFor(() => {
      expect(session.mcpSessionContext?.actorJid).toBeUndefined();
    }, { timeout: 4_000 });
    await bridge!.executeTool('actor_probe', {});
    expect(observedActors.at(-1)).toBeUndefined();
  });

  it('per_chat managed-loop: an actor-less SYSTEM turn after an admin turn is DENIED admin-gated tools (stale admin not inherited)', async () => {
    providerForDouble.value = 'anthropic-api';
    makeRuntime({ sessionScope: 'per_chat' });
    // Real R1 authorizer (the production substrate admin predicate) + a real
    // sensitive tool on the runtime's registry. scope 'chat' so the chat-scoped
    // tier reaches the R1 gate differential (production substrate tools are
    // scope 'global' and additionally scope-rejected on chat tier; the R1
    // sensitive gate runs FIRST and is what this pins).
    const registry = (runtime as unknown as { registry: ToolRegistry }).registry;
    const adminDeps: SubstrateDeps = {
      db: db.raw,
      instanceName: 'test-instance',
      dbWrapper: db,
      adminPhones: new Set<string>(['15550001']),
      memory: {
        adminJid: 'admin@s.whatsapp.net',
        vaultPath: '/tmp/whatsoup-test-vault-bridge-system-turn',
        observationConfidenceMin: 0.5,
        sweep: { beadProposeMin: 0.5, beadUpdateMin: 0.5, lookbackHours: 24, reviewByDays: 7 },
        watchTtl: { defaultHours: 24, maxHours: 168 },
      },
    };
    registry.setSensitiveToolAuthorizer((session) => isAdminActor(adminDeps, session));
    // Records the handler-view session.actorJid — the same value the in-handler
    // assertAdmin defense-in-depth (substrate.ts) reads.
    const handlerViewActors: Array<string | undefined> = [];
    registry.register({
      name: 'admin_chat_probe',
      sensitive: true,
      description: 'Admin-gated chat-scoped probe',
      scope: 'chat',
      targetMode: 'caller-supplied',
      schema: z.object({}),
      handler: async (_params, session) => {
        handlerViewActors.push(session.actorJid);
        return { ok: true };
      },
    });
    await runtime.start();

    // Turn 1: ADMIN human message (senderJid 15550001@... is on adminPhones).
    await arriveMessage();
    const session = await waitForInFlightTurn((t) => t.includes('bridge scoping question'));
    session.emit({ type: 'result', text: 'done' });
    await (runtime as unknown as { turnChain: Promise<void> }).turnChain;

    // Actor-less SYSTEM turn on the SAME managed-loop session — the poll-bridge
    // dispatch shape (markSystemTurn + sendTurnPerChat with actorJid undefined),
    // shared by the heal/recovery/continuation system paths.
    const internals = runtime as unknown as {
      resolvePerChatMapKey(chatJid: string): string;
      markSystemTurn(session: unknown, scopeKey: string, purpose: string, routeChatJid?: string): unknown;
      sendTurnPerChat(
        chatJid: string,
        text: string,
        mapKey?: string,
        actorJid?: string,
        runtimeContext?: unknown,
        scopeRef?: unknown,
        systemTurnLease?: unknown,
      ): Promise<void>;
    };
    const mapKey = internals.resolvePerChatMapKey(chatJid);
    const lease = internals.markSystemTurn(session, mapKey, 'poll_answer_continuation', chatJid);
    const systemDispatch = internals.sendTurnPerChat(
      chatJid, 'system continuation text', mapKey, undefined, undefined, undefined, lease,
    );

    const systemTurnSession = await waitForInFlightTurn((t) => t.includes('system continuation text'));
    expect(systemTurnSession).toBe(session);

    // Mid-system-turn: the executing-turn register holds an actor-less entry,
    // so the bridge's read-time resolver yields undefined and the R1 gate
    // DENIES. On unmodified base the bridge reads the stored conduit, which
    // still holds the ADMIN from turn 1 — the call succeeds (fail-open red).
    const denied = await session.mcpBridge!.executeTool('admin_chat_probe', {});
    expect(denied.isError).toBe(true);
    // The handler never ran — the in-handler assertAdmin view was never even
    // reached, and no stale admin identity was observable anywhere downstream.
    expect(handlerViewActors).toHaveLength(0);

    session.emit({ type: 'result', text: 'sys done' });
    await systemDispatch.catch(() => {});
  });

  it('attribution pin: the stored MCP conduit holds the sender only during the turn', async () => {
    providerForDouble.value = 'anthropic-api';
    makeRuntime({ sessionScope: 'shared' });
    await runtime.start();

    // Before any turn: conduit empty.
    await arriveMessage();
    const session = await waitForInFlightTurn((t) => t.includes('bridge scoping question'));
    expect(session.updateMcpActorJid).toHaveBeenCalledWith(senderJid);
    expect(session.mcpSessionContext?.actorJid).toBe(senderJid);

    session.emit({ type: 'result', text: 'done' });
    await (runtime as unknown as { turnChain: Promise<void> }).turnChain;

    // Turn end retires the conduit at the coordinator post-effects seam.
    await vi.waitFor(() => {
      expect(session.clearMcpActorJid).toHaveBeenCalled();
      expect(session.mcpSessionContext?.actorJid).toBeUndefined();
    }, { timeout: 4_000 });
  });
});
