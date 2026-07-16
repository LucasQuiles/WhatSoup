/**
 * F-STICKY-ACTOR (QR-247): resolveExecutingActor fail-closed / executing-turn HEAD semantics.
 * Reuses the proven per_chat AgentRuntime mock preamble (SessionManager/socket/registry mocked).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type {
  MarkSystemTurnInput,
  SystemTurnLeaseToken,
} from '../../../src/runtimes/agent/pending-system-result-tracker.ts';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const { mockSession, mockQueue, capturedOnEventRef } = vi.hoisted(() => {
  const capturedOnEventRef: { current: ((event: AgentEvent) => void) | null } = { current: null };

  const mockSession = {
    spawnSession: vi.fn(async () => {}),
    sendTurn: vi.fn(async () => {}),
    handleNew: vi.fn(async () => {}),
    getStatus: vi.fn(() => ({
      active: false,
      pid: null as number | null,
      sessionId: null as string | null,
      startedAt: null as string | null,
      messageCount: 0,
      lastMessageAt: null as string | null,
    })),
    shutdown: vi.fn(async () => {}),
    clearTurnWatchdog: vi.fn(() => {}),
    tickWatchdog: vi.fn(() => {}),
    trackToolStart: vi.fn((_toolId: string) => {}),
    trackToolEnd: vi.fn((_toolId: string) => {}),
    bindGenerationOwnership: vi.fn((_resolve: () => unknown) => {}),
    getDbRowId: vi.fn(() => null),
  };

  const mockQueue = {
    enqueueText: vi.fn(),
    getSenderToken: () => 'mock-sender-token',
    enqueueStreamingText: vi.fn(),
    enqueueToolUpdate: vi.fn(),
    indicateTyping: vi.fn(),
    flush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    abortTurn: vi.fn(),
    updateDeliveryJid: vi.fn(),
    setInboundSeq: vi.fn(),
    markLastTerminal: vi.fn(),
    clearLastOpId: vi.fn(),
    setToolUpdateMode: vi.fn(),
    setToolUpdateRedirectJid: vi.fn(),
    setTextAggregateDelayMs: vi.fn(),
    targetChatJid: 'test@s.whatsapp.net',
    getLastOpId: vi.fn(() => undefined),
    setDurability: vi.fn(),
  };

  return { mockSession, mockQueue, capturedOnEventRef };
});

// ── Module mocks ────────────────────────────────────────────────────────────

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/core/messages.ts', () => ({
  getRecentMessages: vi.fn(() => []),
}));

vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  ensureAgentSchema: vi.fn(),
  createSession: vi.fn(() => 1),
  incrementMessageCount: vi.fn(),
  updateSessionId: vi.fn(),
  updateSessionStatus: vi.fn(),
  getActiveSession: vi.fn(() => null),
  backfillWorkspaceKeys: vi.fn(),
  markOrphaned: vi.fn(),
  getResumableSessionForChat: vi.fn(() => null),
  backfillSessionProvider: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/session.ts', () => ({
  SessionManager: vi.fn().mockImplementation(function (
    opts: { onEvent: (event: AgentEvent) => void },
  ) {
    capturedOnEventRef.current = opts.onEvent;
    return mockSession;
  }),
  formatAge: vi.fn(() => '0s ago'),
}));

vi.mock('../../../src/runtimes/agent/outbound-queue.ts', () => ({
  OutboundQueue: vi.fn().mockImplementation(function () {
    return mockQueue;
  }),
}));

vi.mock('../../../src/config.ts', () => ({
  config: {
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full',
    toolUpdateRedirectJid: null,
    textAggregateDelayMs: 2_000,
    agentProvider: 'claude-cli',
    agentProviderConfig: undefined,
    agentFallbacks: [],
    agentFallbackProvider: undefined,
    agentFallbackModel: undefined,
  },
}));

vi.mock('../../../src/core/access-list.ts', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../../src/core/access-list.ts');
  return actual;
});

vi.mock('../../../src/core/workspace.ts', () => ({
  chatJidToWorkspace: vi.fn((_cwd: string, chatJid: string) => {
    const key = chatJid.replace('@s.whatsapp.net', '');
    return { kind: 'dm' as const, workspaceKey: key, workspacePath: `/tmp/${key}` };
  }),
  provisionWorkspace: vi.fn(() => '/tmp/ws/.claude/whatsoup.sock'),
  writeSandboxArtifacts: vi.fn(),
  ensurePermissionsSettings: vi.fn(),
  writePrivateFileSync: vi.fn(),
}));

vi.mock('../../../src/mcp/socket-server.ts', () => ({
  WhatSoupSocketServer: vi.fn().mockImplementation(function () {
    return { start: vi.fn(), stop: vi.fn(), updateDeliveryJid: vi.fn(), updateActorJid: vi.fn(), updateConversationKey: vi.fn(), updateConversationBinding: vi.fn() };
  }),
}));

// #1785 rec-3: exercising the REAL createPerChatActorSocket (not spied away) would
// otherwise hit the real writeMcpConfigToPath -> writePrivateFileSync fs chain
// against the real home directory. Stub just the fs-writing export; everything
// else in this module stays real.
vi.mock('../../../src/runtimes/agent/providers/mcp-bridge.ts', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('../../../src/runtimes/agent/providers/mcp-bridge.ts');
  return { ...actual, writeMcpConfigToPath: vi.fn(() => null) };
});

vi.mock('../../../src/mcp/registry.ts', () => ({
  ToolRegistry: class {
    register = vi.fn();
    listTools = vi.fn(() => []);
    call = vi.fn();
    getChatScopedToolNames = vi.fn(() => []);
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn(), copyFileSync: vi.fn() };
});

vi.mock('../../../src/runtimes/agent/media-bridge.ts', () => ({
  startMediaBridge: vi.fn(() => null),
  setMediaBridgeChat: vi.fn(),
}));

vi.mock('../../../src/core/durability.ts', () => ({
  sendTracked: vi.fn(),
}));

vi.mock('../../../src/core/conversation-key.ts', () => ({
  toConversationKey: vi.fn((jid: string) => jid),
  // runtime.ts derives its global scope-key constants from this at import time.
  GLOBAL_CONVERSATION_KEY: '__global__',
}));

vi.mock('../../../src/core/heal-protocol.ts', () => ({
  EmitHealResultSchema: {},
}));

vi.mock('../../../src/core/heal.ts', () => ({
  dequeueNextReport: vi.fn(),
  emitHealReport: vi.fn(),
}));

vi.mock('../../../src/mcp/register-all.ts', () => ({
  registerAllTools: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/turn-queue.ts', () => {
  class TurnQueue {
    enqueue = vi.fn();
    drain = vi.fn();
    clear = vi.fn();
    setProcessor = vi.fn();
    get pending() { return 0; }
  }
  return { TurnQueue };
});

vi.mock('../../../src/runtimes/agent/control-queue.ts', () => ({
  ControlQueue: vi.fn().mockImplementation(function () {
    return mockQueue;
  }),
}));

vi.mock('../../../src/core/media-mime.ts', () => ({
  extractRawMime: vi.fn(),
}));

// ── Imports ─────────────────────────────────────────────────────────────────

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { WhatSoupSocketServer } from '../../../src/mcp/socket-server.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeDb(): Database {
  return {
    assertWritableCompatibility: vi.fn(),
    raw: {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: vi.fn(), all: vi.fn() }),
    },
  } as unknown as Database;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
    sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
  } as unknown as Messenger;
}

function setOwnedTestSession(runtime: AgentRuntime, mapKey: string, session: unknown): void {
  (runtime as unknown as {
    setOwnedPerChatSession: (key: string, value: unknown) => void;
  }).setOwnedPerChatSession(mapKey, session);
}

function currentCrashIdentity(runtime: AgentRuntime, mapKey: string): {
  generationIdentity: { managerId: string; generation: number };
} {
  const owner = (runtime as unknown as {
    sessionOwnership: { get: (key: string) => { managerId: string; generation: number } | undefined };
  }).sessionOwnership.get(mapKey);
  if (!owner) throw new Error(`missing test owner for ${mapKey}`);
  return { generationIdentity: { managerId: owner.managerId, generation: owner.generation } };
}


// ── F-STICKY-ACTOR tests ─────────────────────────────────────────────────────

describe('F-STICKY-ACTOR: resolveExecutingActor fail-closed / executing-turn HEAD (QR-247)', () => {
  const CHAT = 'group-abc@g.us';
  const ADMIN = 'admin@s.whatsapp.net';
  const GUEST = 'guest@s.whatsapp.net';
  let runtime: AgentRuntime;
  let mapKey: string;

  beforeEach(() => {
    runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', { sessionScope: 'per_chat' });
    // Use the runtime's own keying so the test state lands under the same mapKey
    // resolveExecutingActor derives internally.
    mapKey = (runtime as unknown as { resolvePerChatMapKey(c: string): string }).resolvePerChatMapKey(CHAT);
  });

  function setSession(active: boolean): void {
    (runtime as unknown as { chatSessions: Map<string, unknown> }).chatSessions.set(mapKey, {
      getStatus: () => ({ active }),
    });
  }
  function setQueue(actors: Array<string | undefined>): void {
    (runtime as unknown as { perChatExecActorQueue: Map<string, Array<string | undefined>> })
      .perChatExecActorQueue.set(mapKey, [...actors]);
  }
  function shiftHead(): void {
    (runtime as unknown as { perChatExecActorQueue: Map<string, Array<string | undefined>> })
      .perChatExecActorQueue.get(mapKey)!.shift();
  }
  const resolve = (): string | undefined =>
    (runtime as unknown as { resolveExecutingActor(c: string): string | undefined }).resolveExecutingActor(CHAT);

  it('no session for the chat -> undefined (fail-closed deny)', () => {
    setQueue([ADMIN]);
    expect(resolve()).toBeUndefined();
  });

  it('inactive session -> undefined (fail-closed deny)', () => {
    setSession(false);
    setQueue([ADMIN]);
    expect(resolve()).toBeUndefined();
  });

  it('active session + empty queue -> undefined (fail-closed deny)', () => {
    setSession(true);
    setQueue([]);
    expect(resolve()).toBeUndefined();
  });

  it('active session -> returns the HEAD (oldest-unresolved = currently executing turn), NOT newest-dispatched', () => {
    setSession(true);
    setQueue([ADMIN, GUEST]); // ADMIN dispatched first and still executing; GUEST queued behind
    expect(resolve()).toBe(ADMIN);
  });

  it('after the head turn completes (shift), the head advances to the next turn actor', () => {
    setSession(true);
    setQueue([ADMIN, GUEST]);
    shiftHead();
    expect(resolve()).toBe(GUEST);
  });

  it('a head actor of undefined (e.g. poll re-inject pushes undefined) -> undefined -> deny', () => {
    setSession(true);
    setQueue([undefined, ADMIN]);
    expect(resolve()).toBeUndefined();
  });
});

describe('system continuation actor ownership', () => {
  it('removes the exact admin poll actor before a later guest turn becomes HEAD', () => {
    const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', { sessionScope: 'per_chat' });
    const mapKey = 'group-poll@g.us';
    const lease = { id: 41, scopeKey: mapKey };
    const state = runtime as unknown as {
      perChatExecActorQueue: Map<string, Array<string | undefined>>;
      systemTurnExecActors: Map<number, { scopeKey: string; actorJid: string | undefined }>;
      releaseSystemTurnExecutingActor(turn: {
        lease: typeof lease;
        purpose: 'poll_answer_continuation';
        owner: null;
        blocking: boolean;
      }): void;
    };
    state.perChatExecActorQueue.set(mapKey, [
      'admin@s.whatsapp.net',
      'guest@s.whatsapp.net',
    ]);
    state.systemTurnExecActors.set(lease.id, {
      scopeKey: mapKey,
      actorJid: 'admin@s.whatsapp.net',
    });

    state.releaseSystemTurnExecutingActor({
      lease,
      purpose: 'poll_answer_continuation',
      owner: null,
      blocking: true,
    });

    expect(state.perChatExecActorQueue.get(mapKey)).toEqual(['guest@s.whatsapp.net']);
    expect(state.systemTurnExecActors.has(lease.id)).toBe(false);
  });

  it('releases the exact system actor after timeout teardown proof', async () => {
    const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', { sessionScope: 'per_chat' });
    const mapKey = 'group-timeout@g.us';
    setOwnedTestSession(runtime, mapKey, mockSession);
    const state = runtime as unknown as {
      sessionEventToolScopes: WeakMap<object, string>;
      pendingSystemResults: {
        mark(input: MarkSystemTurnInput): SystemTurnLeaseToken;
        cancel(lease: SystemTurnLeaseToken): boolean;
      };
      perChatExecActorQueue: Map<string, Array<string | undefined>>;
      systemTurnExecActors: Map<number, { scopeKey: string; actorJid: string | undefined }>;
      markSystemTurn(
        session: object,
        scopeKey: string,
        purpose: 'poll_answer_continuation',
        routeChatJid: string,
      ): SystemTurnLeaseToken;
    };
    state.sessionEventToolScopes.set(mockSession, `${mapKey}#1`);
    const mark = vi.spyOn(state.pendingSystemResults, 'mark');
    const lease = state.markSystemTurn(
      mockSession,
      mapKey,
      'poll_answer_continuation',
      mapKey,
    );
    state.perChatExecActorQueue.set(mapKey, [
      'admin@s.whatsapp.net',
      'guest@s.whatsapp.net',
    ]);
    state.systemTurnExecActors.set(lease.id, {
      scopeKey: mapKey,
      actorJid: 'admin@s.whatsapp.net',
    });
    const input = mark.mock.calls[0]![0];
    expect(input.onTimeout).toBeTypeOf('function');

    await expect(input.onTimeout!(lease)).resolves.toBe(true);
    state.pendingSystemResults.cancel(lease);

    expect(mockSession.shutdown).toHaveBeenCalledWith(false);
    expect(state.perChatExecActorQueue.get(mapKey)).toEqual(['guest@s.whatsapp.net']);
    expect(state.systemTurnExecActors.has(lease.id)).toBe(false);
  });
});

// ── F-STICKY-ACTOR S-CRASH tests ─────────────────────────────────────────────

describe('F-STICKY-ACTOR: crash clears the WHOLE executing-actor queue (S-CRASH, QR-247)', () => {
  const CHAT = 'group-crash@g.us';
  const ADMIN = 'admin@s.whatsapp.net';
  const GUEST = 'guest@s.whatsapp.net';
  let runtime: AgentRuntime;
  let mapKey: string;

  type Priv = {
    resolvePerChatMapKey(c: string): string;
    chatSessions: Map<string, unknown>;
    perChatExecActorQueue: Map<string, Array<string | undefined>>;
    handlePerChatCrash(mapKey: string, chatJid: string, info: Record<string, unknown>): void;
    resolveExecutingActor(c: string): string | undefined;
  };
  const priv = (): Priv => runtime as unknown as Priv;

  beforeEach(() => {
    runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', { sessionScope: 'per_chat' });
    mapKey = priv().resolvePerChatMapKey(CHAT);
    // A live session with two in-flight turns: ADMIN executing (HEAD) + GUEST queued behind.
    setOwnedTestSession(runtime, mapKey, mockSession);
    priv().perChatExecActorQueue.set(mapKey, [ADMIN, GUEST]);
  });

  it('handlePerChatCrash clears ALL in-flight entries (not shift-one) -> post-respawn turn is fail-closed', () => {
    // A crash discards the whole subprocess; both in-flight turns are gone.
    priv().handlePerChatCrash(mapKey, CHAT, currentCrashIdentity(runtime, mapKey));
    expect(priv().perChatExecActorQueue.get(mapKey) ?? []).toEqual([]);
    // The crashed turn's actor (ADMIN) must NOT survive as HEAD; the continuation /
    // next turn resolves to undefined -> denied, never stale-authorized as ADMIN.
    expect(priv().resolveExecutingActor(CHAT)).toBeUndefined();
  });
});

// ── F-STICKY-ACTOR F6: durable per-termination-path mutation tests ────────────

describe('F-STICKY-ACTOR F6: replayTurnOnFallback clears the exec-queue (QR-247)', () => {
  const CHAT = 'group-fb@g.us';
  const ADMIN = 'admin@s.whatsapp.net';
  const GUEST = 'guest@s.whatsapp.net';
  let runtime: AgentRuntime;
  let mapKey: string;
  type Priv = {
    resolvePerChatMapKey(c: string): string;
    perChatExecActorQueue: Map<string, Array<string | undefined>>;
    replayTurnOnFallback(args: { chatJid: string; mapKey?: string; replayText: string; actorJid?: string; oldSession: unknown }): Promise<void>;
  };
  const priv = (): Priv => runtime as unknown as Priv;

  beforeEach(() => {
    runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', { sessionScope: 'per_chat' });
    mapKey = priv().resolvePerChatMapKey(CHAT);
  });

  it('clears the whole queue before replaying (mutation target: revert delete -> RED)', async () => {
    priv().perChatExecActorQueue.set(mapKey, [ADMIN, GUEST]); // stale in-flight on the killed child
    // Isolate the clear: stub the recreate + replay (they re-push on their own).
    vi.spyOn(runtime as unknown as { recreatePerChatSessionForFallback: (...a: unknown[]) => void }, 'recreatePerChatSessionForFallback').mockImplementation(() => {});
    vi.spyOn(runtime as unknown as { sendTurnPerChat: (...a: unknown[]) => Promise<void> }, 'sendTurnPerChat').mockResolvedValue(undefined);
    await priv().replayTurnOnFallback({ chatJid: CHAT, mapKey, replayText: 'x', actorJid: ADMIN, oldSession: null });
    expect(priv().perChatExecActorQueue.get(mapKey) ?? []).toEqual([]);
  });
});

describe('F-STICKY-ACTOR F6: dispatch to an INACTIVE session clears stale entries (QR-247)', () => {
  const CHAT = 'group-inactive@g.us';
  const ADMIN = 'admin@s.whatsapp.net';
  const GUEST = 'guest@s.whatsapp.net';
  let runtime: AgentRuntime;
  let mapKey: string;
  type Priv = {
    resolvePerChatMapKey(c: string): string;
    chatSessions: Map<string, unknown>;
    chatQueues: Map<string, unknown>;
    perChatExecActorQueue: Map<string, Array<string | undefined>>;
    sendTurnToSession(session: unknown, chatJid: string, text: string, mapKey?: string, actorJid?: string): Promise<void>;
  };
  const priv = (): Priv => runtime as unknown as Priv;

  beforeEach(() => {
    runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', { sessionScope: 'per_chat' });
    mapKey = priv().resolvePerChatMapKey(CHAT);
  });

  it('clear-if-inactive drops the dead subprocess entries before pushing the fresh turn (revert -> RED)', async () => {
    const inactive = {
      ...mockSession,
      getStatus: () => ({ active: false, sessionId: null, pid: null, startedAt: null, messageCount: 0, lastMessageAt: null }),
      spawnSession: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
      sendTurn: vi.fn(async () => {}),
    };
    setOwnedTestSession(runtime, mapKey, inactive);
    priv().chatQueues.set(mapKey, mockQueue);
    priv().perChatExecActorQueue.set(mapKey, [GUEST]); // stale from a dead subprocess (e.g. resume-fail)
    await priv().sendTurnToSession(inactive, CHAT, 'admin turn', mapKey, ADMIN);
    // The stale GUEST is dropped at the push (session inactive) — only the fresh ADMIN turn remains.
    expect(priv().perChatExecActorQueue.get(mapKey)).toEqual([ADMIN]);
  });
});

describe('F-STICKY-ACTOR F6: LID-rekey migrates the exec-queue + socket to canonical (F4, QR-247)', () => {
  const ADMIN = 'admin@s.whatsapp.net';
  const GUEST = 'guest@s.whatsapp.net';
  let runtime: AgentRuntime;
  type Priv = {
    resolvePerChatMapKey(c: string): string;
    chatSessions: Map<string, unknown>;
    perChatExecActorQueue: Map<string, Array<string | undefined>>;
    perChatSocketResources: Map<string, unknown>;
    handleJidAliasChanged(conversationKey: string, newJid: string): void;
  };
  const priv = (): Priv => runtime as unknown as Priv;

  beforeEach(() => {
    runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', { sessionScope: 'per_chat' });
  });

  it('migrates exec-queue + socket lidKey -> canonical; nothing left under lidKey (revert migrate -> RED)', () => {
    const convKey = '15551234567';
    const lidKey = `${convKey}@lid`;
    const newJid = `${convKey}@s.whatsapp.net`;
    const canonical = priv().resolvePerChatMapKey(newJid);
    // Preconditions for the per_chat rekey branch: a session + in-flight state under lidKey.
    setOwnedTestSession(runtime, lidKey, mockSession);
    priv().perChatExecActorQueue.set(lidKey, [ADMIN, GUEST]);
    const sockRes = { socketServer: { stop: vi.fn(), updateDeliveryJid: vi.fn() }, socketPath: '/tmp/x.sock', cfgPath: '/tmp/x.mcp.json' };
    priv().perChatSocketResources.set(lidKey, sockRes);

    priv().handleJidAliasChanged(convKey, newJid);

    // Migrated to canonical; the trailing cleanupPerChatState(lidKey) finds nothing under lidKey.
    expect(priv().perChatExecActorQueue.get(lidKey)).toBeUndefined();
    expect(priv().perChatExecActorQueue.get(canonical)).toEqual([ADMIN, GUEST]);
    expect(priv().perChatSocketResources.get(canonical)).toBe(sockRes);
    expect(priv().perChatSocketResources.get(lidKey)).toBeUndefined();
  });
});

// ── QR-247 HARDENING: per-session provider keying + choke point (F2/F3/F4/#14) ──

describe('F-STICKY-ACTOR hardening: wirePerChatActorSocket keys on the ACTUAL provider (QR-247 F2/#14)', () => {
  const CHAT = 'group-route@g.us';
  type Priv = {
    resolvePerChatMapKey(c: string): string;
    perChatSocketResources: Map<string, { socketServer: { stop: ReturnType<typeof vi.fn> }; socketPath: string; cfgPath: string }>;
    createPerChatActorSocket(mapKey: string, chatJid: string): { socketPath: string; cfgPath: string };
    wirePerChatActorSocket(chatJid: string, provider: string):
      | { mcpSocketPath: string; providerConfigOverride: { mcpConfig: string[]; strictMcpConfig: true } }
      | undefined;
  };
  let runtime: AgentRuntime;
  let mapKey: string;
  const priv = (): Priv => runtime as unknown as Priv;

  beforeEach(() => {
    runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', { sessionScope: 'per_chat' });
    mapKey = priv().resolvePerChatMapKey(CHAT);
  });

  // Spy the socket factory so the create/teardown DECISION is tested without real sockets/fs.
  function spyCreate(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(runtime as unknown as { createPerChatActorSocket: Priv['createPerChatActorSocket'] }, 'createPerChatActorSocket')
      .mockImplementation((mk: string) => {
        priv().perChatSocketResources.set(mk, { socketServer: { stop: vi.fn() }, socketPath: `/tmp/${mk}.sock`, cfgPath: `/tmp/${mk}.mcp.json` });
        return { socketPath: `/tmp/${mk}.sock`, cfgPath: `/tmp/${mk}.mcp.json` };
      });
  }

  it('claude-cli session -> wires a per-chat actor socket + returns the strict mcp override', () => {
    const create = spyCreate();
    const override = priv().wirePerChatActorSocket(CHAT, 'claude-cli');
    expect(create).toHaveBeenCalledWith(mapKey, CHAT);
    expect(priv().perChatSocketResources.has(mapKey)).toBe(true);
    expect(override).toEqual({
      mcpSocketPath: `/tmp/${mapKey}.sock`,
      providerConfigOverride: { mcpConfig: [`/tmp/${mapKey}.mcp.json`], strictMcpConfig: true },
    });
  });

  it('non-claude session (route/fallback divergence) -> NO socket, override undefined (F2: keyed on actual provider, not instance-global claude-cli)', () => {
    const create = spyCreate();
    const override = priv().wirePerChatActorSocket(CHAT, 'codex-cli');
    expect(override).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(priv().perChatSocketResources.has(mapKey)).toBe(false);
  });

  it('claude-cli -> non-claude fallback TEARS DOWN the per-chat socket (stop + remove) so the socket server is not leaked when the chat moves to the shared global socket (#14)', () => {
    const stop = vi.fn();
    // Pre-seed as if a claude-cli session had already wired its socket.
    priv().perChatSocketResources.set(mapKey, { socketServer: { stop }, socketPath: `/tmp/${mapKey}.sock`, cfgPath: `/tmp/${mapKey}.mcp.json` });
    const override = priv().wirePerChatActorSocket(CHAT, 'gemini-cli');
    expect(override).toBeUndefined();
    expect(stop).toHaveBeenCalled();
    expect(priv().perChatSocketResources.has(mapKey)).toBe(false);
  });

  it('sandboxPerChat and single scope are unaffected (helper returns undefined, no socket)', () => {
    const sandbox = new AgentRuntime(makeDb(), makeMessenger(), 'test', { sessionScope: 'per_chat', sandboxPerChat: true });
    const single = new AgentRuntime(makeDb(), makeMessenger(), 'test', {});
    expect((sandbox as unknown as Priv).wirePerChatActorSocket(CHAT, 'claude-cli')).toBeUndefined();
    expect((single as unknown as Priv).wirePerChatActorSocket(CHAT, 'claude-cli')).toBeUndefined();
    expect((sandbox as unknown as Priv).perChatSocketResources.has((sandbox as unknown as Priv).resolvePerChatMapKey(CHAT))).toBe(false);
  });
});

describe('F-STICKY-ACTOR hardening: createSessionManager is the single wiring choke point (QR-247 F2/F3/F4)', () => {
  const CHAT = 'dm-choke@s.whatsapp.net';
  type Priv = {
    resolvePerChatMapKey(c: string): string;
    perChatSocketResources: Map<string, unknown>;
    createPerChatActorSocket(mapKey: string, chatJid: string): { socketPath: string; cfgPath: string };
    wirePerChatActorSocket(chatJid: string, provider: string): unknown;
    createSessionManager(opts: Record<string, unknown>): unknown;
  };
  let runtime: AgentRuntime;
  let mapKey: string;
  const priv = (): Priv => runtime as unknown as Priv;
  const baseOpts = () => ({ chatJid: CHAT, cwd: '/tmp/choke', onEvent: () => {}, onCrash: () => {}, notifyUser: () => {} });

  beforeEach(() => {
    runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', { sessionScope: 'per_chat' });
    mapKey = priv().resolvePerChatMapKey(CHAT);
  });

  it('createSessionManager itself wires the per-chat socket (moved off the ensureSessionAndQueueSync call site so resume/fallback are covered too)', () => {
    const create = vi.spyOn(runtime as unknown as { createPerChatActorSocket: Priv['createPerChatActorSocket'] }, 'createPerChatActorSocket')
      .mockImplementation((mk: string) => {
        (priv().perChatSocketResources as Map<string, unknown>).set(mk, { socketServer: { stop: vi.fn() }, socketPath: `/tmp/${mk}.sock`, cfgPath: `/tmp/${mk}.mcp.json` });
        return { socketPath: `/tmp/${mk}.sock`, cfgPath: `/tmp/${mk}.mcp.json` };
      });
    priv().createSessionManager(baseOpts());
    expect(create).toHaveBeenCalledWith(mapKey, CHAT);
    expect(priv().perChatSocketResources.has(mapKey)).toBe(true);
  });

  it('fail-closed choke-point guard: an eligible per_chat claude-cli spawn that wires NO socket throws instead of silently using the shared global socket', () => {
    vi.spyOn(runtime as unknown as { wirePerChatActorSocket: Priv['wirePerChatActorSocket'] }, 'wirePerChatActorSocket')
      .mockReturnValue(undefined); // simulate a future path that bypasses wiring
    expect(() => priv().createSessionManager(baseOpts())).toThrow(/QR-247|actor-bound socket/i);
  });
});

describe('F-STICKY-ACTOR hardening: race-exposure warning covers claude-primary + cli-fallback (QR-247 F11)', () => {
  type Priv = { agentFallbacks: Array<{ provider: string; model?: string }>; nlRoutingEnabled: boolean; perChatActorRaceExposed(): boolean; exposedCliProviders(): string[] };
  const priv = (r: AgentRuntime): Priv => r as unknown as Priv;

  it('nlRouting live-pin surface: claude-only config + nlRouting enabled -> EXPOSED (a per-sender /model pin can route a turn to a non-claude CLI provider at runtime — QR-263)', () => {
    const r = new AgentRuntime(makeDb(), makeMessenger(), 'test', { sessionScope: 'per_chat' });
    priv(r).agentFallbacks = [];
    priv(r).nlRoutingEnabled = true;
    expect(priv(r).exposedCliProviders()).toEqual([]); // static set stays honest
    expect(priv(r).perChatActorRaceExposed()).toBe(true); // dynamic pin surface counts
  });

  it('nlRouting live-pin surface: sandboxPerChat stays unaffected even with nlRouting enabled', () => {
    const r = new AgentRuntime(makeDb(), makeMessenger(), 'test', { sessionScope: 'per_chat', sandboxPerChat: true });
    priv(r).agentFallbacks = [];
    priv(r).nlRoutingEnabled = true;
    expect(priv(r).perChatActorRaceExposed()).toBe(false);
  });

  it('claude-cli primary + a codex-cli fallback -> EXPOSED (the case the old endsWith(-cli) && !==claude-cli check silently missed)', () => {
    const r = new AgentRuntime(makeDb(), makeMessenger(), 'test', { sessionScope: 'per_chat' });
    priv(r).agentFallbacks = [{ provider: 'codex-cli' }];
    expect(priv(r).exposedCliProviders()).toEqual(['codex-cli']);
    expect(priv(r).perChatActorRaceExposed()).toBe(true);
  });

  it('claude-cli primary + NO fallbacks -> not exposed (fully covered by the per-chat socket)', () => {
    const r = new AgentRuntime(makeDb(), makeMessenger(), 'test', { sessionScope: 'per_chat' });
    priv(r).agentFallbacks = [];
    expect(priv(r).exposedCliProviders()).toEqual([]);
    expect(priv(r).perChatActorRaceExposed()).toBe(false);
  });

  it('sandboxPerChat is unaffected (its own per-workspace socket) even with a cli fallback', () => {
    const r = new AgentRuntime(makeDb(), makeMessenger(), 'test', { sessionScope: 'per_chat', sandboxPerChat: true });
    priv(r).agentFallbacks = [{ provider: 'gemini-cli' }];
    expect(priv(r).perChatActorRaceExposed()).toBe(false);
  });
});

// ── #1785 rec-3: the per-chat actor socket binds conversationKey ────────────

describe('#1785 rec-3: createPerChatActorSocket binds conversationKey (closes the per_chat send-confinement gap)', () => {
  const CHAT = 'group-bound@g.us';
  type Priv = {
    wirePerChatActorSocket(chatJid: string, provider: string):
      | { mcpSocketPath: string; providerConfigOverride: { mcpConfig: string[]; strictMcpConfig: true } }
      | undefined;
  };
  let runtime: AgentRuntime;
  const priv = (): Priv => runtime as unknown as Priv;

  beforeEach(() => {
    runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', { sessionScope: 'per_chat' });
    (WhatSoupSocketServer as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  it('claude-cli session -> the actor socket SessionContext carries conversationKey bound to its own chat (RED before the fix: conversationKey was permanently undefined, so the registry/messaging cross-conversation guards failed open for every per_chat send)', () => {
    const override = priv().wirePerChatActorSocket(CHAT, 'claude-cli');
    expect(override).toBeDefined();
    expect(WhatSoupSocketServer).toHaveBeenCalledTimes(1);
    const sessionArg = (WhatSoupSocketServer as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(sessionArg).toMatchObject({ tier: 'global', conversationKey: CHAT });
  });

  it('default (perChatConversationBound unset) -> the actor socket session carries NO binding (status quo preserved)', () => {
    priv().wirePerChatActorSocket(CHAT, 'claude-cli');
    const sessionArg = (WhatSoupSocketServer as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2];
    // Exact #1785 rec-3 shape — no binding, no deliveryJid, nothing else.
    expect(sessionArg).toEqual({ tier: 'global', allowedRoot: expect.any(String), conversationKey: CHAT });
  });
});

// ── perChatConversationBound: opt-in conversation-bound actor socket ────────

describe('perChatConversationBound: the actor socket carries a frozen conversation binding and rekeys it on JID alias change', () => {
  const CHAT = 'group-bound@g.us';
  const NEW_JID = 'group-bound-new@g.us';
  type Priv = {
    wirePerChatActorSocket(chatJid: string, provider: string): unknown;
    handleJidAliasChanged(conversationKey: string, newJid: string, deferIfActive?: boolean): void;
  };
  let runtime: AgentRuntime;
  const priv = (): Priv => runtime as unknown as Priv;

  beforeEach(() => {
    runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', {
      sessionScope: 'per_chat',
      perChatConversationBound: true,
    });
    (WhatSoupSocketServer as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  it('flag on -> the actor socket SessionContext carries the frozen conversation binding with coherent mirrors', () => {
    priv().wirePerChatActorSocket(CHAT, 'claude-cli');
    expect(WhatSoupSocketServer).toHaveBeenCalledTimes(1);
    const sessionArg = (WhatSoupSocketServer as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(sessionArg).toMatchObject({
      tier: 'global',
      conversationKey: CHAT, // toConversationKey is identity-mocked in this file
      deliveryJid: CHAT,
      binding: { kind: 'conversation-bound', conversationKey: CHAT, deliveryJid: CHAT },
    });
    expect(Object.isFrozen(sessionArg.binding)).toBe(true);
  });

  it('handleJidAliasChanged rekeys the binding atomically on the per-chat actor socket', () => {
    priv().wirePerChatActorSocket(CHAT, 'claude-cli');
    const instance = (WhatSoupSocketServer as unknown as ReturnType<typeof vi.fn>).mock.results[0]!.value as {
      updateConversationBinding: ReturnType<typeof vi.fn>;
    };
    priv().handleJidAliasChanged(CHAT, NEW_JID, false);
    expect(instance.updateConversationBinding).toHaveBeenCalledWith(NEW_JID);
  });
});
