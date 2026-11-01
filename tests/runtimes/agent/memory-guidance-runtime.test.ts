// Memory guidance wiring: the runtime hands a session the memory guidance block
// only when memory is configured (startup readiness got past its local checks)
// AND memory_write is listed for that session's tool context and allowed by any
// explicit sandbox allowlist. Agent instances have no automatic memory write
// path, so without the block the model is never told to save anything.
//
// REAL AgentRuntime + REAL ToolRegistry + REAL coordinator; the provider
// boundary is faked (same pattern as bridge-actor-scoping.test.ts). register-all
// is mocked to a noop, so each case registers exactly the memory tools it needs
// on the runtime's own registry, then sends one message and reads the options
// the runtime passed to the SessionManager it spawned.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prepareRuntimeHome } from '../../helpers/runtime-home-fixture.ts';
import { z } from 'zod';
import type { Messenger, IncomingMessage } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import { toConversationKey } from '../../../src/core/conversation-key.ts';

// ─── Hoisted provider-boundary doubles ──────────────────────────────────────

const { sessionDoubles, resetDoubles, makeSessionDouble, makeQueueDouble } = vi.hoisted(() => {
  type SessionCtorOpts = {
    chatJid: string;
    provider?: string;
    memoryGuidanceBlock?: () => string | null;
    onEvent: (event: AgentEvent) => void;
  };

  function makeSessionDouble(opts: SessionCtorOpts) {
    let active = false;
    let pendingResolve: (() => void) | null = null;
    let pendingPromise: Promise<void> = Promise.resolve();
    const double = {
      ctorOpts: opts,
      get turnInFlight(): boolean {
        return pendingResolve !== null;
      },
      emit(event: AgentEvent): void {
        opts.onEvent(event);
      },
      spawnSession: vi.fn(async () => {
        active = true;
      }),
      sendTurn: vi.fn(() => {
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
      updateMcpActorJid: vi.fn(),
      clearMcpActorJid: vi.fn(),
      clearTurnWatchdog: vi.fn(),
      tickWatchdog: vi.fn(),
      trackToolStart: vi.fn(),
      trackToolEnd: vi.fn(),
      getDbRowId: vi.fn((): number | null => 1),
      setDurability: vi.fn(),
      bindGenerationOwnership: vi.fn(),
      getProviderId: vi.fn(() => opts.provider ?? 'claude-cli'),
      getModelRef: vi.fn(() => undefined),
    };
    return double;
  }

  function makeQueueDouble(chatJid: string) {
    return {
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
  }

  const sessionDoubles: Array<ReturnType<typeof makeSessionDouble>> = [];

  function resetDoubles(): void {
    sessionDoubles.length = 0;
  }

  return { sessionDoubles, resetDoubles, makeSessionDouble, makeQueueDouble };
});

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    agentProvider: 'claude-cli' as string,
    adminPhones: new Set<string>(['15550001']),
    controlPeers: new Map<string, string>(),
    internalPeerJids: new Set<string>(),
    toolUpdateMode: 'full' as const,
    toolUpdateRedirectJid: null as string | null,
    textAggregateDelayMs: 2_000,
    stateRoot: `/tmp/whatsoup-test-state-memory-guidance-${process.pid}`,
    restartLoopGuard: { enabled: true, maxRestarts: 3, windowMs: 300_000 },
    startupNotifications: false,
    proactiveResumeOnStartup: false,
    mediaDir: `/tmp/whatsoup-test-media-memory-guidance-${process.pid}`,
    pineconeAllowedIndexes: [] as string[],
    pineconeIndex: 'memory',
    voiceReply: 'never' as const,
    elevenlabs: { defaultVoiceId: 'v', defaultModel: 'm', stability: 0.5, similarityBoost: 0.75 },
    memory: { adminJid: 'admin@s.whatsapp.net' },
  },
}));

// ─── Module mocks (same surface as bridge-actor-scoping.test.ts) ─────────────

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
    provider?: string;
    memoryGuidanceBlock?: () => string | null;
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
  OutboundQueue: vi.fn().mockImplementation(function (_messenger: unknown, chatJid: string) {
    return makeQueueDouble(chatJid);
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
import { AgentRuntime, type AgentRuntimeOptions } from '../../../src/runtimes/agent/runtime.ts';
import type { MemoryReadinessSnapshot } from '../../../src/runtimes/agent/memory-guidance.ts';
import { installFakePerChatMcpSocketManager } from './helpers/fake-per-chat-mcp-socket-manager.ts';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const chatJid = '15550002@s.whatsapp.net';
const senderJid = '15550002@s.whatsapp.net';
const MEMORY_TOOLS = ['memory_write', 'knowledge_search'] as const;
type MemoryTool = (typeof MEMORY_TOOLS)[number];
const READY: MemoryReadinessSnapshot = { state: 'ready', evidenceCoverage: 'provider_response' };

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

function makeMsg(messageId: string, inboundSeq: number): IncomingMessage {
  return {
    messageId,
    chatJid,
    senderJid,
    senderName: 'Test User',
    content: 'memory guidance question',
    contentText: null,
    contentType: 'text',
    isFromMe: false,
    isGroup: false,
    mentionedJids: [],
    timestamp: Date.now(),
    quotedMessageId: null,
    isResponseWorthy: true,
    inboundSeq,
  };
}

describe('memory guidance wiring', () => {
  let db: Database;
  let engine: DurabilityEngine;
  let runtime: AgentRuntime | undefined;

  /**
   * Build a runtime with the given memory tools on its real registry, send one
   * message, return the spawned session's options. The knowledge_search
   * stand-in accepts `searchIndexes`, as the real tool's `index` enum does.
   */
  async function spawnedSessionOpts(
    options: AgentRuntimeOptions,
    tools: readonly MemoryTool[],
    searchIndexes: [string, ...string[]] = [mockConfig.pineconeIndex],
  ): Promise<(typeof sessionDoubles)[number]['ctorOpts']> {
    runtime = new AgentRuntime(db, makeMessenger(), 'test', options);
    installFakePerChatMcpSocketManager(runtime);
    runtime.setDurability(engine);
    const registry = (runtime as unknown as { registry: ToolRegistry }).registry;
    for (const name of tools) {
      registry.register({
        name,
        description: `${name} stand-in`,
        scope: 'chat',
        targetMode: name === 'memory_write' ? 'injected' : 'caller-supplied',
        schema: name === 'memory_write'
          ? z.object({ chatJid: z.string() })
          : z.object({ index: z.enum(searchIndexes), query: z.string() }),
        handler: async () => ({ ok: true }),
      });
    }
    await runtime.start();

    const messageId = `msg-memory-${Math.random().toString(36).slice(2, 8)}`;
    const seq = engine.journalInbound(messageId, toConversationKey(chatJid), chatJid, 'agent');
    void runtime.handleMessage(makeMsg(messageId, seq));
    let spawned: (typeof sessionDoubles)[number] | undefined;
    await vi.waitFor(() => {
      spawned = sessionDoubles.find((s) => s.turnInFlight);
      expect(spawned).toBeDefined();
    }, { timeout: 4_000 });
    return spawned!.ctorOpts;
  }

  beforeEach(async () => {
    await prepareRuntimeHome();
    vi.clearAllMocks();
    resetDoubles();
    mockConfig.agentProvider = 'claude-cli';
    db = new Database(':memory:');
    db.open();
    engine = new DurabilityEngine(db);
  });

  afterEach(async () => {
    for (const session of sessionDoubles) {
      if (session.turnInFlight) session.emit({ type: 'result', text: 'late' });
    }
    await runtime?.shutdown();
    runtime = undefined;
    db.close();
  });

  for (const provider of ['claude-cli', 'anthropic-api'] as const) {
    it(`${provider}: a memory-ready per_chat session gets the guidance block`, async () => {
      mockConfig.agentProvider = provider;
      const opts = await spawnedSessionOpts({ sessionScope: 'per_chat', memoryReadiness: READY }, MEMORY_TOOLS);

      expect(opts.provider).toBe(provider);
      const block = opts.memoryGuidanceBlock?.() ?? '';
      expect(block).toContain('memory_write');
      expect(block).toContain('Memories are saved to this chat.');
      expect(block).toContain('Check knowledge_search first');
    });
  }

  it('a shared-scope session (no pinned conversation at spawn) still gets the block', async () => {
    const opts = await spawnedSessionOpts({ sessionScope: 'shared', memoryReadiness: READY }, MEMORY_TOOLS);

    expect(opts.memoryGuidanceBlock?.()).toContain('memory_write');
  });

  it('keeps the block when the startup provider call failed (memory configured, provider unreachable)', async () => {
    const opts = await spawnedSessionOpts(
      { sessionScope: 'per_chat', memoryReadiness: { state: 'network_error', evidenceCoverage: 'provider_error' } },
      MEMORY_TOOLS,
    );

    expect(opts.memoryGuidanceBlock?.()).toContain('Save only what will matter in a later conversation');
  });

  it('omits the knowledge_search line when only memory_write is listed', async () => {
    const opts = await spawnedSessionOpts({ sessionScope: 'per_chat', memoryReadiness: READY }, ['memory_write']);

    const block = opts.memoryGuidanceBlock?.() ?? '';
    expect(block).toContain('memory_write');
    expect(block).not.toContain('knowledge_search');
  });

  it('omits the knowledge_search line when search cannot reach the memory index', async () => {
    const opts = await spawnedSessionOpts({ sessionScope: 'per_chat', memoryReadiness: READY }, MEMORY_TOOLS, ['docs']);

    const block = opts.memoryGuidanceBlock?.() ?? '';
    expect(block).toContain('Save only what will matter in a later conversation');
    expect(block).not.toContain('knowledge_search');
  });

  // Each negative case also pins the spawned provider, so a session really was
  // created and the missing block is the runtime's decision, not a missed spawn.
  const NO_GUIDANCE = { provider: 'claude-cli', memoryGuidanceBlock: undefined };

  it('no block when memory is locally disabled at startup (no index or key)', async () => {
    const opts = await spawnedSessionOpts(
      { sessionScope: 'per_chat', memoryReadiness: { state: 'disabled', evidenceCoverage: 'local_guard' } },
      MEMORY_TOOLS,
    );
    expect({ provider: opts.provider, memoryGuidanceBlock: opts.memoryGuidanceBlock }).toEqual(NO_GUIDANCE);
  });

  it('no block when the project guard is missing at startup (local check)', async () => {
    const opts = await spawnedSessionOpts(
      { sessionScope: 'per_chat', memoryReadiness: { state: 'project_mismatch', evidenceCoverage: 'local_guard' } },
      MEMORY_TOOLS,
    );
    expect({ provider: opts.provider, memoryGuidanceBlock: opts.memoryGuidanceBlock }).toEqual(NO_GUIDANCE);
  });

  it('no block when readiness was never supplied', async () => {
    const opts = await spawnedSessionOpts({ sessionScope: 'per_chat' }, MEMORY_TOOLS);
    expect({ provider: opts.provider, memoryGuidanceBlock: opts.memoryGuidanceBlock }).toEqual(NO_GUIDANCE);
  });

  it('no block when memory_write is not registered (memory disabled)', async () => {
    const opts = await spawnedSessionOpts({ sessionScope: 'per_chat', memoryReadiness: READY }, ['knowledge_search']);
    expect({ provider: opts.provider, memoryGuidanceBlock: opts.memoryGuidanceBlock }).toEqual(NO_GUIDANCE);
  });

  it('no block when the instance sandbox allowlist omits memory_write', async () => {
    const opts = await spawnedSessionOpts({
      sessionScope: 'per_chat',
      memoryReadiness: READY,
      sandbox: { allowedPaths: [], allowedTools: [], bash: { enabled: false }, allowedMcpTools: ['mcp__whatsoup__knowledge_search'] },
    }, MEMORY_TOOLS);
    expect({ provider: opts.provider, memoryGuidanceBlock: opts.memoryGuidanceBlock }).toEqual(NO_GUIDANCE);
  });
});
