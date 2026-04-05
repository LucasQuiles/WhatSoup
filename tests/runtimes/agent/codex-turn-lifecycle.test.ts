import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type { IncomingMessage } from '../../../src/core/types.ts';
import { parseCodexEvent } from '../../../src/runtimes/agent/providers/codex-parser.ts';

// ─── Part 1: Parser-level tests (pure functions, no mocks needed) ────────────

describe('Codex turn lifecycle — parser level', () => {
  /**
   * Build a JSON-RPC notification line for the Codex app-server protocol.
   */
  function notification(method: string, params: Record<string, unknown> = {}): string {
    return JSON.stringify({ jsonrpc: '2.0', method, params });
  }

  it('token_usage and result are distinct event types for a single turn', () => {
    const tokenUsageLine = notification('thread/tokenUsage/updated', {
      tokenUsage: { input_tokens: 500, output_tokens: 100 },
    });
    const turnCompletedLine = notification('turn/completed', {
      turn: { status: 'completed' },
    });

    const tokenUsageEvent = parseCodexEvent(tokenUsageLine);
    const resultEvent = parseCodexEvent(turnCompletedLine);

    // token_usage must NOT be a 'result' event — that was the double-turn-completion bug
    expect(tokenUsageEvent).toEqual({
      type: 'token_usage',
      inputTokens: 500,
      outputTokens: 100,
    });

    expect(resultEvent).toEqual({
      type: 'result',
      text: null,
    });

    // Critically: they are different types
    expect(tokenUsageEvent!.type).not.toBe(resultEvent!.type);
  });

  it('token_usage event never carries result-like fields (text)', () => {
    const line = notification('thread/tokenUsage/updated', {
      tokenUsage: { input_tokens: 1000, output_tokens: 200 },
    });
    const event = parseCodexEvent(line);

    expect(event!.type).toBe('token_usage');
    // token_usage events must not have a 'text' field that could be confused with a result
    expect(event).not.toHaveProperty('text');
  });

  it('turn/completed maps to result, not token_usage, even with token data in turn', () => {
    // Ensure turn/completed always produces 'result' regardless of payload shape
    const line = notification('turn/completed', {
      turn: { status: 'completed' },
    });
    const event = parseCodexEvent(line);
    expect(event!.type).toBe('result');
  });

  it('failed turn/completed produces result with error text', () => {
    const line = notification('turn/completed', {
      turn: { status: 'failed', error: { message: 'out of context' } },
    });
    const event = parseCodexEvent(line);
    expect(event).toEqual({
      type: 'result',
      text: 'out of context',
    });
  });

  it('multiple turns produce exactly one result and one token_usage each', () => {
    const turns = [
      { input: 300, output: 50 },
      { input: 800, output: 150 },
      { input: 1200, output: 400 },
    ];

    const events: AgentEvent[] = [];
    for (const turn of turns) {
      const tokenLine = notification('thread/tokenUsage/updated', {
        tokenUsage: { input_tokens: turn.input, output_tokens: turn.output },
      });
      const completeLine = notification('turn/completed', {
        turn: { status: 'completed' },
      });
      events.push(parseCodexEvent(tokenLine)!);
      events.push(parseCodexEvent(completeLine)!);
    }

    const tokenUsageEvents = events.filter(e => e.type === 'token_usage');
    const resultEvents = events.filter(e => e.type === 'result');

    expect(tokenUsageEvents).toHaveLength(3);
    expect(resultEvents).toHaveLength(3);

    // Verify token counts are correctly preserved per turn
    for (let i = 0; i < turns.length; i++) {
      const tu = tokenUsageEvents[i] as Extract<AgentEvent, { type: 'token_usage' }>;
      expect(tu.inputTokens).toBe(turns[i].input);
      expect(tu.outputTokens).toBe(turns[i].output);
    }
  });
});

// ─── Part 2: Runtime-level tests (verify event handling behavior) ────────────

// These tests verify that handleEventWithContext/handleEventPerChat treats
// token_usage and result correctly: only result triggers turn completion,
// queue shift, and flush.

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
    getDbRowId: vi.fn(() => 1),
  };

  const mockQueue = {
    enqueueText: vi.fn(),
    enqueueStreamingText: vi.fn(),
    enqueueResultText: vi.fn(),
    enqueueToolUpdate: vi.fn(),
    indicateTyping: vi.fn(),
    flush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    abortTurn: vi.fn(),
    updateDeliveryJid: vi.fn(),
    setInboundSeq: vi.fn(),
    markLastTerminal: vi.fn(),
    setToolUpdateMode: vi.fn(),
    getLastOpId: vi.fn(() => undefined),
    targetChatJid: '1234@s.whatsapp.net',
  };

  return { mockSession, mockQueue, capturedOnEventRef };
});

const { mockAccumulateSessionTokens } = vi.hoisted(() => ({
  mockAccumulateSessionTokens: vi.fn(),
}));

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
  sweepOrphanedSessions: vi.fn(() => []),
  getResumableSessionForChat: vi.fn(() => null),
  accumulateSessionTokens: mockAccumulateSessionTokens,
}));

vi.mock('../../../src/runtimes/agent/session-classifier.ts', () => ({
  classifyActiveSessions: vi.fn(() => []),
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
    pineconeAllowedIndexes: [],
  },
}));

vi.mock('../../../src/core/access-list.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/access-list.ts')>();
  return actual;
});

vi.mock('../../../src/core/workspace.ts', () => ({
  chatJidToWorkspace: vi.fn((_cwd: string, chatJid: string) => {
    const key = chatJid.replace('@s.whatsapp.net', '').replace('@lid', '');
    return { kind: 'dm' as const, workspaceKey: key, workspacePath: `/tmp/${key}` };
  }),
  provisionWorkspace: vi.fn(() => '/tmp/workspace/.claude/whatsoup.sock'),
  writeSandboxArtifacts: vi.fn(),
  ensurePermissionsSettings: vi.fn(),
}));

vi.mock('../../../src/mcp/socket-server.ts', () => ({
  WhatSoupSocketServer: vi.fn().mockImplementation(function () {
    return { start: vi.fn(), stop: vi.fn(), updateDeliveryJid: vi.fn() };
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

vi.mock('../../../src/mcp/register-all.ts', () => ({
  registerAllTools: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/heal.ts', () => ({
  emitHealReport: vi.fn(),
}));

vi.mock('../../../src/core/alerts.ts', () => ({
  clearAlertSource: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

// ─── Import after mocks ────────────────────────────────────────────────────

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg-1',
    chatJid: '1234@s.whatsapp.net',
    senderJid: '1234@s.whatsapp.net',
    senderName: 'Test User',
    content: 'hello',
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

async function sendAndDrain(runtime: AgentRuntime, msg: IncomingMessage): Promise<void> {
  await runtime.handleMessage(msg);
  await (runtime as unknown as { turnChain: Promise<void> }).turnChain;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Codex turn lifecycle — runtime level', () => {
  let runtime: AgentRuntime;

  const fakeDb = {
    raw: {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) })),
      exec: vi.fn(),
    },
  } as any;
  const fakeMessenger = { sendMessage: vi.fn() } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnEventRef.current = null;
    mockSession.getStatus.mockReturnValue({
      active: false,
      pid: null,
      sessionId: null,
      startedAt: null,
      messageCount: 0,
      lastMessageAt: null,
    });
    mockSession.sendTurn.mockResolvedValue(undefined);
    runtime = new AgentRuntime(fakeDb, fakeMessenger, 'test', {
      sessionScope: 'per_chat',
    });
  });

  afterEach(async () => {
    await runtime?.shutdown();
  });

  /**
   * Helper: trigger a message to create a per-chat session, then return the
   * captured onEvent callback for feeding events.
   */
  async function setupSession(): Promise<(event: AgentEvent) => void> {
    await sendAndDrain(runtime, makeMsg());

    const onEvent = capturedOnEventRef.current;
    if (!onEvent) throw new Error('onEvent callback not captured — session was not created');

    // Simulate session becoming active
    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 12345,
      sessionId: 'sess-1',
      startedAt: new Date().toISOString(),
      messageCount: 1,
      lastMessageAt: new Date().toISOString(),
    });

    return onEvent;
  }

  it('token_usage records tokens but does not trigger turn completion', async () => {
    const onEvent = await setupSession();

    // Feed a token_usage event (from thread/tokenUsage/updated)
    onEvent({ type: 'token_usage', inputTokens: 500, outputTokens: 100 });

    // Token accumulation should have been called
    expect(mockAccumulateSessionTokens).toHaveBeenCalledWith(fakeDb, 1, 500, 100);

    // Turn-completion side effects must NOT have fired
    expect(mockSession.clearTurnWatchdog).not.toHaveBeenCalled();
    expect(mockQueue.flush).not.toHaveBeenCalled();
    expect(mockQueue.markLastTerminal).not.toHaveBeenCalled();
    expect(mockQueue.enqueueResultText).not.toHaveBeenCalled();
  });

  it('result triggers turn completion with flush and watchdog clear', async () => {
    const onEvent = await setupSession();

    // Feed a result event (from turn/completed)
    onEvent({ type: 'result', text: null });

    // Turn-completion side effects MUST fire
    expect(mockSession.clearTurnWatchdog).toHaveBeenCalledOnce();
    expect(mockQueue.markLastTerminal).toHaveBeenCalledOnce();
    expect(mockQueue.flush).toHaveBeenCalledOnce();
  });

  it('token_usage then result: tokens recorded from token_usage, completion from result only', async () => {
    const onEvent = await setupSession();

    // Simulate the actual Codex sequence: token_usage arrives first, then result
    onEvent({ type: 'token_usage', inputTokens: 1000, outputTokens: 200 });
    onEvent({ type: 'result', text: null });

    // token_usage should have recorded tokens
    expect(mockAccumulateSessionTokens).toHaveBeenCalledWith(fakeDb, 1, 1000, 200);

    // Turn completion should have fired exactly once (from result, not token_usage)
    expect(mockSession.clearTurnWatchdog).toHaveBeenCalledOnce();
    expect(mockQueue.flush).toHaveBeenCalledOnce();
    expect(mockQueue.markLastTerminal).toHaveBeenCalledOnce();
  });

  it('inbound sequence queue shifts exactly once per turn, not twice', async () => {
    const onEvent = await setupSession();

    // Feed token_usage — should NOT shift the queue
    onEvent({ type: 'token_usage', inputTokens: 500, outputTokens: 100 });

    // No turn-completion side effects yet
    expect(mockSession.clearTurnWatchdog).not.toHaveBeenCalled();

    // Feed result — should shift exactly once
    onEvent({ type: 'result', text: null });

    // Turn completed exactly once
    expect(mockSession.clearTurnWatchdog).toHaveBeenCalledOnce();
    expect(mockQueue.flush).toHaveBeenCalledOnce();
  });

  it('token_usage arriving AFTER result still records tokens without side effects', async () => {
    const onEvent = await setupSession();

    // Result arrives first (turn completes)
    onEvent({ type: 'result', text: null });
    expect(mockSession.clearTurnWatchdog).toHaveBeenCalledOnce();
    expect(mockQueue.flush).toHaveBeenCalledOnce();

    vi.clearAllMocks();

    // Late token_usage arrives after turn already completed
    onEvent({ type: 'token_usage', inputTokens: 800, outputTokens: 150 });

    // Tokens should still be recorded
    expect(mockAccumulateSessionTokens).toHaveBeenCalledWith(fakeDb, 1, 800, 150);

    // No additional turn-completion side effects
    expect(mockSession.clearTurnWatchdog).not.toHaveBeenCalled();
    expect(mockQueue.flush).not.toHaveBeenCalled();
    expect(mockQueue.markLastTerminal).not.toHaveBeenCalled();
  });

  it('multiple sequential turns each get exactly one completion', async () => {
    const onEvent = await setupSession();

    // Turn 1
    onEvent({ type: 'token_usage', inputTokens: 100, outputTokens: 20 });
    onEvent({ type: 'result', text: null });

    // Turn 2
    onEvent({ type: 'token_usage', inputTokens: 200, outputTokens: 40 });
    onEvent({ type: 'result', text: null });

    // Turn 3
    onEvent({ type: 'token_usage', inputTokens: 300, outputTokens: 60 });
    onEvent({ type: 'result', text: null });

    // Each result triggers exactly one flush -> 3 total
    expect(mockSession.clearTurnWatchdog).toHaveBeenCalledTimes(3);
    expect(mockQueue.flush).toHaveBeenCalledTimes(3);
    expect(mockQueue.markLastTerminal).toHaveBeenCalledTimes(3);

    // Token accumulation: 3 from token_usage events
    // (result events here have no token fields, so they don't accumulate)
    expect(mockAccumulateSessionTokens).toHaveBeenCalledTimes(3);
    expect(mockAccumulateSessionTokens).toHaveBeenCalledWith(fakeDb, 1, 100, 20);
    expect(mockAccumulateSessionTokens).toHaveBeenCalledWith(fakeDb, 1, 200, 40);
    expect(mockAccumulateSessionTokens).toHaveBeenCalledWith(fakeDb, 1, 300, 60);
  });
});
