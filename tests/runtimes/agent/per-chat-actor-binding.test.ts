/**
 * F-STICKY-ACTOR (QR-247): resolveExecutingActor fail-closed / executing-turn HEAD semantics.
 * Reuses the proven per_chat AgentRuntime mock preamble (SessionManager/socket/registry mocked).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';

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
    return { start: vi.fn(), stop: vi.fn(), updateDeliveryJid: vi.fn(), updateActorJid: vi.fn(), updateConversationKey: vi.fn() };
  }),
}));

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
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeDb(): Database {
  return {
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
    priv().chatSessions.set(mapKey, { getStatus: () => ({ active: true }), getDbRowId: () => null });
    priv().perChatExecActorQueue.set(mapKey, [ADMIN, GUEST]);
  });

  it('handlePerChatCrash clears ALL in-flight entries (not shift-one) -> post-respawn turn is fail-closed', () => {
    // A crash discards the whole subprocess; both in-flight turns are gone.
    priv().handlePerChatCrash(mapKey, CHAT, {}); // info={} -> no auto-respawn timer scheduled
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
    priv().chatSessions.set(mapKey, inactive);
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
    priv().chatSessions.set(lidKey, { getStatus: () => ({ active: true }), getDbRowId: () => null });
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
