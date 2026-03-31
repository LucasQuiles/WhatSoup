import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Database } from '../../../src/core/database.ts';
import type { IncomingMessage, Messenger } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────
// vi.hoisted values are available inside vi.mock factory callbacks.

const { mockSession, mockQueue, capturedOnEventRef, capturedOnResumeFailedRef } = vi.hoisted(() => {
  const capturedOnEventRef: { current: ((event: AgentEvent) => void) | null } = { current: null };
  const capturedOnResumeFailedRef: { current: (() => void) | null } = { current: null };

  const mockSession = {
    spawnSession: vi.fn(async () => {}),
    sendTurn: vi.fn(async () => {}),
    handleNew: vi.fn(async () => {}),
    getStatus: vi.fn(() => ({ active: false, pid: null as number | null, sessionId: null as string | null, startedAt: null as string | null, messageCount: 0, lastMessageAt: null as string | null })),
    shutdown: vi.fn(async () => {}),
    clearTurnWatchdog: vi.fn(() => {}),
    tickWatchdog: vi.fn(() => {}),
    trackToolStart: vi.fn((_toolId: string) => {}),
    trackToolEnd: vi.fn((_toolId: string) => {}),
  };

  // NOTE: IOutboundQueue cannot be imported inside vi.hoisted() (runs before imports),
  // but the satisfies check below (outside hoisted) enforces interface compliance
  // at compile time. TypeScript will error if OutboundQueue gains a new public
  // method that isn't reflected here — the mock cannot silently diverge.
  const mockQueue = {
    enqueueText: vi.fn(),
    enqueueToolUpdate: vi.fn(),
    indicateTyping: vi.fn(),
    flush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    abortTurn: vi.fn(),
    updateDeliveryJid: vi.fn(),
    setInboundSeq: vi.fn(),
    markLastTerminal: vi.fn(),
  };

  return { mockSession, mockQueue, capturedOnEventRef, capturedOnResumeFailedRef };
});

// ─── Module mocks ─────────────────────────────────────────────────────────────

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

type ActiveSessionRow = { id: number; session_id: string | null; chat_jid: string | null; claude_pid: number; status: string; started_at: string; last_message_at: string | null; message_count: number } | null;
const { mockGetActiveSession } = vi.hoisted(() => {
  return { mockGetActiveSession: vi.fn(() => null as ActiveSessionRow) };
});

const { mockBackfillWorkspaceKeys, mockSweepOrphanedSessions, mockGetResumableSessionForChat } = vi.hoisted(() => ({
  mockBackfillWorkspaceKeys: vi.fn(),
  mockSweepOrphanedSessions: vi.fn(() => [] as { id: number; claude_pid: number }[]),
  mockGetResumableSessionForChat: vi.fn(() => null as { id: number; session_id: string; chat_jid: string } | null),
}));

vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  ensureAgentSchema: vi.fn(),
  createSession: vi.fn(() => 1),
  incrementMessageCount: vi.fn(),
  updateSessionId: vi.fn(),
  updateSessionStatus: vi.fn(),
  getActiveSession: mockGetActiveSession,
  backfillWorkspaceKeys: mockBackfillWorkspaceKeys,
  markOrphaned: vi.fn(),
  sweepOrphanedSessions: mockSweepOrphanedSessions,
  getResumableSessionForChat: mockGetResumableSessionForChat,
}));

vi.mock('../../../src/runtimes/agent/session.ts', () => ({
  // eslint-disable-next-line prefer-arrow-callback
  SessionManager: vi.fn().mockImplementation(function (
    opts: { onEvent: (event: AgentEvent) => void; onResumeFailed?: () => void },
  ) {
    capturedOnEventRef.current = opts.onEvent;
    capturedOnResumeFailedRef.current = opts.onResumeFailed ?? null;
    return mockSession;
  }),
  formatAge: vi.fn((isoString: string) => {
    const ms = Date.now() - new Date(isoString).getTime();
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
    return `${Math.floor(ms / 3_600_000)}h ago`;
  }),
}));

vi.mock('../../../src/runtimes/agent/outbound-queue.ts', () => ({
  // eslint-disable-next-line prefer-arrow-callback
  OutboundQueue: vi.fn().mockImplementation(function () {
    return mockQueue;
  }),
}));

// Mock config.adminPhones — default includes the test admin phone
vi.mock('../../../src/config.ts', () => ({
  config: {
    adminPhones: new Set<string>(['18459780919']),
  },
}));

// extractPhone is a pure function — no need to mock, but mock the module so
// vi.mock doesn't try to load the real database-importing module chain.
vi.mock('../../../src/core/access-list.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/access-list.ts')>();
  return actual;
});

// Mock workspace utilities so sandboxPerChat tests don't touch the filesystem
const { mockChatJidToWorkspace, mockProvisionWorkspace } = vi.hoisted(() => ({
  mockChatJidToWorkspace: vi.fn((_instanceCwd: string, chatJid: string) => {
    // Default: strip @s.whatsapp.net → phone as key
    const key = chatJid.replace('@s.whatsapp.net', '').replace('@lid', '');
    return {
      kind: 'dm' as const,
      workspaceKey: key,
      workspacePath: `/tmp/${key}`,
    };
  }),
  mockProvisionWorkspace: vi.fn(() => '/tmp/workspace/.claude/whatsoup.sock'),
}));

vi.mock('../../../src/core/workspace.ts', () => ({
  chatJidToWorkspace: mockChatJidToWorkspace,
  provisionWorkspace: mockProvisionWorkspace,
  writeSandboxArtifacts: vi.fn(),
}));

// Mock WhatSoupSocketServer so tests don't bind real Unix sockets.
// mockSocketServerInstance is hoisted so vi.mock factory can reference it,
// and MockWhatSoupSocketServer is a vi.fn() so tests can inspect constructor calls.
const { mockSocketServerInstance, MockWhatSoupSocketServer } = vi.hoisted(() => {
  const mockSocketServerInstance = {
    start: vi.fn(),
    stop: vi.fn(),
    updateDeliveryJid: vi.fn(),
  };
  // eslint-disable-next-line prefer-arrow-callback
  const MockWhatSoupSocketServer = vi.fn().mockImplementation(function () {
    return mockSocketServerInstance;
  });
  return { mockSocketServerInstance, MockWhatSoupSocketServer };
});

vi.mock('../../../src/mcp/socket-server.ts', () => ({
  WhatSoupSocketServer: MockWhatSoupSocketServer,
}));

vi.mock('../../../src/mcp/registry.ts', () => ({
  ToolRegistry: class {
    register = vi.fn();
    listTools = vi.fn(() => []);
    call = vi.fn();
  },
}));

// Mock node:fs for socket server path creation in start()
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

// ─── Compile-time mock interface enforcement ──────────────────────────────────
// This assignment fails TypeScript compilation if mockQueue is missing any
// method declared in IOutboundQueue — the mock cannot silently diverge from
// the real OutboundQueue public interface.
const _mockQueueTypeCheck: IOutboundQueue = mockQueue;
void _mockQueueTypeCheck; // suppress unused-variable warning

// ─── Import after mocks ───────────────────────────────────────────────────────

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { getRecentMessages } from '../../../src/core/messages.ts';
import { tmpdir } from 'node:os';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(): Database {
  return {
    raw: {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })),
      exec: vi.fn(),
    },
  } as unknown as Database;
}

function makeMessenger(): { messenger: Messenger; sentMessages: Array<{ jid: string; text: string }> } {
  const sentMessages: Array<{ jid: string; text: string }> = [];
  const messenger: Messenger = {
    sendMessage: vi.fn(async (jid: string, text: string) => {
      sentMessages.push({ jid, text });
    }),
  };
  return { messenger, sentMessages };
}

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg-1',
    chatJid: 'test@s.whatsapp.net',
    senderJid: 'sender@s.whatsapp.net',
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

/**
 * Call handleMessage and wait for the turn chain to settle.
 * handleMessage enqueues work onto turnChain without awaiting it, so tests
 * must drain the chain to observe side effects synchronously.
 */
async function sendAndDrain(runtime: AgentRuntime, msg: IncomingMessage): Promise<void> {
  await runtime.handleMessage(msg);
  // Access the private turnChain field to wait for the queued inner work.
  await (runtime as unknown as { turnChain: Promise<void> }).turnChain;
}

/**
 * Like sendAndDrain, but also waits for the TurnQueue to fully drain.
 * Required for shared-mode tests where turns are processed asynchronously
 * inside the TurnQueue rather than inline in _handleMessageInner.
 */
async function sendAndDrainShared(runtime: AgentRuntime, msg: IncomingMessage): Promise<void> {
  await sendAndDrain(runtime, msg);
  // Wait for the TurnQueue to fully drain
  await (runtime as unknown as { turnQueue: { idle: () => Promise<void> } }).turnQueue.idle();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnEventRef.current = null;
    mockSession.getStatus.mockReturnValue({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });
    mockSession.sendTurn.mockResolvedValue(undefined);
    mockGetActiveSession.mockReturnValue(null);
    mockSweepOrphanedSessions.mockReturnValue([]);
    mockGetResumableSessionForChat.mockReturnValue(null);
    mockChatJidToWorkspace.mockImplementation((_instanceCwd: string, chatJid: string) => {
      const key = chatJid.replace('@s.whatsapp.net', '').replace('@lid', '');
      return { kind: 'dm' as const, workspaceKey: key, workspacePath: `/tmp/${key}` };
    });
  });

  it('start() calls ensureAgentSchema', async () => {
    const { ensureAgentSchema } = await import('../../../src/runtimes/agent/session-db.ts');
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();

    expect(ensureAgentSchema).toHaveBeenCalledWith(db);
  });

  it('handleMessage ignores null content', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: null }));

    expect(mockSession.sendTurn).not.toHaveBeenCalled();
  });

  it('handleMessage ignores empty content', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: '   ' }));

    expect(mockSession.sendTurn).not.toHaveBeenCalled();
  });

  it('handleMessage /new calls session.handleNew and notifies user', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: '/new' }));

    expect(mockSession.handleNew).toHaveBeenCalled();
    const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(enqueuedTexts.some((t) => t.includes('new session'))).toBe(true);
  });

  it('/new calls abortTurn() on the old queue before replacing it', async () => {
    // abortTurn() must fire BEFORE the new queue is created — it clears the typing
    // heartbeat interval and tool timers so the old session's state does not bleed
    // into the new one.
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    // First message seeds the queue
    await sendAndDrain(runtime, makeMsg({ content: 'start a turn' }));
    mockQueue.abortTurn.mockClear();

    await sendAndDrain(runtime, makeMsg({ content: '/new' }));

    expect(mockQueue.abortTurn).toHaveBeenCalledTimes(1);
  });

  it('handleMessage /status sends status when inactive', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: '/status' }));

    const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(enqueuedTexts.some((t) => t.includes('No active session'))).toBe(true);
  });

  it('handleMessage /status sends status when active', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: true, pid: 9999, sessionId: 'ses_abc', startedAt: new Date(Date.now() - 120_000).toISOString(), messageCount: 3, lastMessageAt: new Date(Date.now() - 30_000).toISOString() });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: '/status' }));

    const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(enqueuedTexts.some((t) => t.includes('9999'))).toBe(true);
  });

  it('/status with active session includes all fields', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 1234,
      sessionId: 'abc12345-xyz',
      startedAt: new Date(Date.now() - 300_000).toISOString(),
      messageCount: 7,
      lastMessageAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: '/status' }));

    const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(enqueuedTexts).toHaveLength(1);
    const text = enqueuedTexts[0];
    expect(text).toContain('Session active');
    expect(text).toContain('PID: `1234`');
    expect(text).toContain('Session: `abc12345...');
    expect(text).toContain('Messages: 7');
    expect(text).toContain('Started:');
    expect(text).toContain('Last activity:');
  });

  it('/status with no session returns no-session message', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: '/status' }));

    const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(enqueuedTexts.some((t) => t.includes('No active session'))).toBe(true);
  });

  it('/status session ID truncated to 8 chars + ellipsis', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 42,
      sessionId: 'abcdefghijklmnop',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      messageCount: 1,
      lastMessageAt: new Date(Date.now() - 10_000).toISOString(),
    });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: '/status' }));

    const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(enqueuedTexts.some((t) => t.includes('abcdefgh...'))).toBe(true);
  });

  it('handleMessage /help sends help text', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: '/help' }));

    const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(enqueuedTexts.some((t) => t.includes('/new'))).toBe(true);
    expect(enqueuedTexts.some((t) => t.includes('/status'))).toBe(true);
  });

  it('handleMessage regular message calls sendTurn and spawnSession if not active', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: 'hello claude' }));

    expect(mockSession.spawnSession).toHaveBeenCalled();
    expect(mockSession.sendTurn).toHaveBeenCalledWith('hello claude');
  });

  it('handleMessage regular message does not re-spawn if already active', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date(Date.now() - 60_000).toISOString(), messageCount: 1, lastMessageAt: new Date(Date.now() - 10_000).toISOString() });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'follow-up' }));

    expect(mockSession.spawnSession).not.toHaveBeenCalled();
    expect(mockSession.sendTurn).toHaveBeenCalledWith('follow-up');
  });

  it('forwarded slash command is sent as a turn', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date(Date.now() - 60_000).toISOString(), messageCount: 1, lastMessageAt: new Date(Date.now() - 10_000).toISOString() });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: '/compact' }));

    expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');
  });


  // ─── B02: STDIN_WRITE_TIMEOUT handling ────────────────────────────────────

  it('handleMessage catches STDIN_WRITE_TIMEOUT and sends user-facing message', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date(Date.now() - 60_000).toISOString(), messageCount: 1, lastMessageAt: new Date(Date.now() - 10_000).toISOString() });
    mockSession.sendTurn.mockRejectedValue(new Error('STDIN_WRITE_TIMEOUT: agent not reading input'));

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: 'hello' }));

    const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(enqueuedTexts.some((t) => t.includes('not responding'))).toBe(true);
    expect(enqueuedTexts.some((t) => t.includes('/new'))).toBe(true);
  });

  it('handleMessage non-timeout errors from sendTurn do not propagate to caller (swallowed by chain)', async () => {
    // The turn serializer chain uses .catch(() => {}) to prevent one failed turn
    // from breaking subsequent turns. Non-timeout errors are therefore swallowed
    // rather than re-thrown to the handleMessage caller.
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date(Date.now() - 60_000).toISOString(), messageCount: 1, lastMessageAt: new Date(Date.now() - 10_000).toISOString() });
    mockSession.sendTurn.mockRejectedValue(new Error('some other error'));

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();

    // handleMessage must not reject — error is swallowed by the chain's .catch(() => {})
    await expect(sendAndDrain(runtime, makeMsg({ content: 'hello' }))).resolves.toBeUndefined();
  });

  // ─── Event routing ─────────────────────────────────────────────────────────

  it('assistant_text event enqueues text', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    // trigger session creation
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'assistant_text', text: 'Hello there!' });

    expect(mockQueue.enqueueText).toHaveBeenCalledWith('Hello there!');
  });

  it('tool_use event enqueues tool update', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'tool_use', toolName: 'Bash', toolId: 'tool_1', toolInput: { command: 'git status' } });

    expect(mockQueue.enqueueToolUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'running' }),
    );
  });

  it('buildToolUpdate Bash — no description: detail is monospace first command line', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'tool_use', toolName: 'Bash', toolId: 't1', toolInput: { command: 'git status\ngit diff' } });

    expect(mockQueue.enqueueToolUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'running', detail: '`git status`' }),
    );
  });

  it('buildToolUpdate Bash — with description: detail is plain text (no backticks)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'tool_use', toolName: 'Bash', toolId: 't2', toolInput: { command: 'git status', description: 'Show git status' } });

    expect(mockQueue.enqueueToolUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'running', detail: 'Show git status' }),
    );
  });

  it('buildToolUpdate Read — includes line range in detail when limit/offset present', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'tool_use', toolName: 'Read', toolId: 't3', toolInput: { file_path: '/home/q/LAB/WhatSoup/src/main.ts', offset: 10, limit: 5 } });

    const call = (mockQueue.enqueueToolUpdate.mock.calls.at(-1) as [{ category: string; detail: string }])[0];
    expect(call.category).toBe('reading');
    expect(call.detail).toContain('L10');
    expect(call.detail).toContain('L14');
  });

  it('buildToolUpdate Glob — uses two-line format with scope on second line', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'tool_use', toolName: 'Glob', toolId: 't4', toolInput: { pattern: '**/*.ts', path: '/home/q/LAB/WhatSoup/src' } });

    const call = (mockQueue.enqueueToolUpdate.mock.calls.at(-1) as [{ category: string; detail: string }])[0];
    expect(call.category).toBe('searching');
    expect(call.detail).toContain('`**/*.ts`');
    expect(call.detail).toContain('\n→');
  });

  it('buildToolUpdate Grep — uses two-line format with scope on second line', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'tool_use', toolName: 'Grep', toolId: 't5', toolInput: { pattern: 'flushToolBuffer', glob: '*.ts' } });

    const call = (mockQueue.enqueueToolUpdate.mock.calls.at(-1) as [{ category: string; detail: string }])[0];
    expect(call.category).toBe('searching');
    expect(call.detail).toContain('`flushToolBuffer`');
    expect(call.detail).toContain('\n→');
  });

  // @check CHK-023
  // @traces REQ-005.AC-05
  it('compact_boundary event enqueues notification through queue', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'compact_boundary' });

    expect(mockQueue.enqueueText).toHaveBeenCalledWith(
      expect.stringContaining('ompact'),
    );
  });

  it('result event with prior text flushes queue without fallback', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'assistant_text', text: 'Hello' });
    capturedOnEventRef.current!({ type: 'result', text: null });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(mockQueue.flush).toHaveBeenCalled();
    // Should not add fallback because there was prior text
    const calls = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(calls).not.toContain('_(no response)_');
  });

  it('result event with no prior text enqueues fallback message', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    // No assistant_text event — go straight to result
    capturedOnEventRef.current!({ type: 'result', text: null });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const calls = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(calls).toContain('_(no response)_');
    expect(mockQueue.flush).toHaveBeenCalled();
  });

  it('result event with text enqueues the text', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'result', text: 'Context limit reached' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const calls = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(calls).toContain('Context limit reached');
    expect(mockQueue.flush).toHaveBeenCalled();
  });

  it('tool_result with isError enqueues tool error update', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'tool_result', isError: true, toolId: 'test', content: 'error msg' });

    expect(mockQueue.enqueueToolUpdate).toHaveBeenCalledWith({ category: 'error', detail: 'Tool Error' });
  });

  it('tool_result with isError=false does not enqueue anything', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'tool_result', isError: false, toolId: 'test', content: '' });

    expect(mockQueue.enqueueToolUpdate).not.toHaveBeenCalled();
  });

  // ─── Health snapshot ───────────────────────────────────────────────────────

  it('getHealthSnapshot returns healthy with session counts', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();

    const snap = runtime.getHealthSnapshot();
    expect(snap.status).toBe('healthy');
    expect(snap.details).toHaveProperty('active');
    expect(snap.details).toHaveProperty('pid');
    expect(snap.details).toHaveProperty('sessionId');
  });

  // ─── Shutdown ──────────────────────────────────────────────────────────────

  it('shutdown calls session.shutdown and queue.shutdown', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' })); // creates session + queue

    await runtime.shutdown();

    expect(mockSession.shutdown).toHaveBeenCalled();
    expect(mockQueue.shutdown).toHaveBeenCalled();
  });

  // ─── Session resume ────────────────────────────────────────────────────────

  it('start() with resumable session — spawns with resume and sets pending startup message', async () => {
    const db = makeDb();
    const { messenger, sentMessages } = makeMessenger();

    mockGetActiveSession.mockReturnValue({
      id: 1,
      session_id: 'sess-123',
      chat_jid: 'user@s.whatsapp.net',
      claude_pid: 0,
      status: 'active',
      started_at: new Date(Date.now() - 120_000).toISOString(),
      last_message_at: null,
      message_count: 0,
    });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();

    expect(mockSession.spawnSession).toHaveBeenCalledWith('sess-123', 1);
    // start() defers the message via pendingStartupMessage (main.ts pops it after WA connects)
    expect(sentMessages).toHaveLength(0);
    const pending = runtime.popStartupMessage();
    expect(pending).not.toBeNull();
    expect(pending!.chatJid).toBe('user@s.whatsapp.net');
    expect(pending!.text).toContain('Resuming');
  });

  it('resume failure — sends expiry message and spawns fresh session', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockGetActiveSession.mockReturnValue({
      id: 1,
      session_id: 'sess-expired',
      chat_jid: 'user@s.whatsapp.net',
      claude_pid: 0,
      status: 'active',
      started_at: new Date(Date.now() - 3_600_000).toISOString(),
      last_message_at: null,
      message_count: 0,
    });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();

    // Pop the pending startup message to simulate WA connecting
    runtime.popStartupMessage();

    // Simulate SessionManager calling onResumeFailed (WA is now connected)
    expect(capturedOnResumeFailedRef.current).not.toBeNull();
    capturedOnResumeFailedRef.current!();

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // Should enqueue the expiry message through the queue (WA connected, pending already popped)
    const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(enqueuedTexts.some((t) => t.includes('expired'))).toBe(true);
    expect(enqueuedTexts.some((t) => t.includes('fresh'))).toBe(true);

    // Should spawn a fresh session (no resume ID)
    // spawnSession called once for the initial resume attempt, then once fresh
    expect(mockSession.spawnSession).toHaveBeenCalledTimes(2);
    expect(mockSession.spawnSession).toHaveBeenLastCalledWith();
  });

  it('resume failure before WA connects — overrides pending startup message', async () => {
    const db = makeDb();
    const { messenger, sentMessages } = makeMessenger();

    mockGetActiveSession.mockReturnValue({
      id: 1,
      session_id: 'sess-expired',
      chat_jid: 'user@s.whatsapp.net',
      claude_pid: 0,
      status: 'active',
      started_at: new Date(Date.now() - 3_600_000).toISOString(),
      last_message_at: null,
      message_count: 0,
    });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();

    // Don't pop — simulate failure before WA connects
    capturedOnResumeFailedRef.current!();

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // Should NOT have sent directly (WA not connected)
    expect(sentMessages).toHaveLength(0);

    // The pending message should now be the expiry message (not the resume message)
    const pending = runtime.popStartupMessage();
    expect(pending).not.toBeNull();
    expect(pending!.text).toContain('expired');
    expect(pending!.text).not.toContain('Resuming');
  });

  it('start() with no active session — no spawn, no message', async () => {
    const db = makeDb();
    const { messenger, sentMessages } = makeMessenger();

    mockGetActiveSession.mockReturnValue(null);

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();

    expect(mockSession.spawnSession).not.toHaveBeenCalled();
    expect(sentMessages).toHaveLength(0);
  });

  it('start() with active session but no session_id — no resume', async () => {
    const db = makeDb();
    const { messenger, sentMessages } = makeMessenger();

    mockGetActiveSession.mockReturnValue({
      id: 1,
      session_id: null,
      chat_jid: 'user@s.whatsapp.net',
      claude_pid: 0,
      status: 'active',
      started_at: new Date(Date.now() - 60_000).toISOString(),
      last_message_at: null,
      message_count: 0,
    });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();

    expect(mockSession.spawnSession).not.toHaveBeenCalled();
    expect(sentMessages).toHaveLength(0);
  });

  // ─── P3-C: resume failure with recent messages injects CONTEXT RECOVERY ──────

  it('resume failure — sendTurn called with CONTEXT RECOVERY prefix when messages exist', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockGetActiveSession.mockReturnValue({
      id: 1,
      session_id: 'sess-expired',
      chat_jid: 'user@s.whatsapp.net',
      claude_pid: 0,
      status: 'active',
      started_at: new Date(Date.now() - 3_600_000).toISOString(),
      last_message_at: null,
      message_count: 0,
    });

    // Provide mock recent messages
    vi.mocked(getRecentMessages).mockReturnValue([
      {
        pk: 1,
        chatJid: 'user@s.whatsapp.net',
        senderJid: 'sender@s.whatsapp.net',
        senderName: 'Alice',
        messageId: 'msg-1',
        content: 'Hello there',
        contentType: 'text',
        isFromMe: false,
        timestamp: 1_700_000_000,
        quotedMessageId: null,
        enrichmentProcessedAt: null,
        enrichmentRetries: 0,
        createdAt: new Date().toISOString(),
      },
    ]);

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    runtime.popStartupMessage();

    capturedOnResumeFailedRef.current!();
    // Wait for the spawnSession().then() and the turnChain to settle
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await (runtime as unknown as { turnChain: Promise<void> }).turnChain;

    const sendTurnCalls = mockSession.sendTurn.mock.calls as unknown as [string][];
    expect(sendTurnCalls.length).toBeGreaterThan(0);
    const contextCall = sendTurnCalls.find((args) =>
      args[0].includes('CONTEXT RECOVERY'),
    );
    expect(contextCall).toBeDefined();
    expect(contextCall![0]).toContain('Alice');
  });

  it('/new creates a fresh OutboundQueue to isolate sessions', async () => {
    const { OutboundQueue: MockOutboundQueueCtor } = await import('../../../src/runtimes/agent/outbound-queue.ts');
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: 'hi' }));

    const constructorCallsBefore = (MockOutboundQueueCtor as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    mockSession.getStatus.mockReturnValue({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });
    await sendAndDrain(runtime, makeMsg({ content: '/new' }));

    const constructorCallsAfter = (MockOutboundQueueCtor as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(constructorCallsAfter).toBeGreaterThan(constructorCallsBefore);
  });

  // ─── Shared session: multi-chat routing ──────────────────────────────────

  // @check CHK-062
// @traces REQ-012.AC-01
  it('shared: messages enqueue to TurnQueue and are processed one at a time', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date().toISOString(), messageCount: 0, lastMessageAt: null });

    const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
    await runtime.start();

    await sendAndDrainShared(runtime, makeMsg({ chatJid: 'chat-a@g.us', senderJid: '111@s.whatsapp.net', content: 'hello from A', isGroup: true }));
    await sendAndDrainShared(runtime, makeMsg({ chatJid: 'chat-b@s.whatsapp.net', senderJid: '222@s.whatsapp.net', content: 'hello from B', isGroup: false }));

    // Both messages should be forwarded to Claude Code as turns
    expect(mockSession.sendTurn).toHaveBeenCalledTimes(2);
  });

  // @check CHK-063
// @traces REQ-012.AC-04
  it('shared: queued messages produce no system acknowledgment', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date().toISOString(), messageCount: 0, lastMessageAt: null });

    const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
    await runtime.start();
    await sendAndDrainShared(runtime, makeMsg({ chatJid: 'chat-a@s.whatsapp.net', content: 'hello' }));

    // No system message should be enqueued for a regular message
    const textsBefore = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(textsBefore.some((t) => t.includes('queued') || t.includes('wait'))).toBe(false);
  });

  // @check CHK-064
// @traces REQ-012.AC-02
  it('shared: DM turn prefixed with [DM from <name> (<phone>)]', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date().toISOString(), messageCount: 0, lastMessageAt: null });

    const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
    await runtime.start();
    await sendAndDrainShared(runtime, makeMsg({
      chatJid: '18459780919@s.whatsapp.net',
      senderJid: '18459780919@s.whatsapp.net',
      senderName: 'Jason',
      content: 'test message',
      isGroup: false,
    }));

    expect(mockSession.sendTurn).toHaveBeenCalledWith(
      expect.stringContaining('[DM from Jason (18459780919)]'),
    );
    expect(mockSession.sendTurn).toHaveBeenCalledWith(
      expect.stringContaining('test message'),
    );
  });

  // @check CHK-064
// @traces REQ-012.AC-02
  it('shared: group turn prefixed with [Group: <chatJid> — <senderName>]', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date().toISOString(), messageCount: 0, lastMessageAt: null });

    const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
    await runtime.start();
    await sendAndDrainShared(runtime, makeMsg({
      chatJid: 'the-group@g.us',
      senderJid: '18459780919@s.whatsapp.net',
      senderName: 'Jason',
      content: 'group message',
      isGroup: true,
    }));

    expect(mockSession.sendTurn).toHaveBeenCalledWith(
      expect.stringContaining('[Group: the-group@g.us — Jason]'),
    );
    expect(mockSession.sendTurn).toHaveBeenCalledWith(
      expect.stringContaining('group message'),
    );
  });

  // @check CHK-065
// @traces REQ-012.AC-03
  it('shared: events route to the originating chat outbound queue', async () => {
    const { OutboundQueue: MockOutboundQueueCtor } = await import('../../../src/runtimes/agent/outbound-queue.ts');
    const db = makeDb();
    const { messenger } = makeMessenger();

    // Track which chatJids OutboundQueue was constructed with
    const constructedFor: string[] = [];
    // Must use 'function' (not arrow) — arrow functions cannot be constructors
    // eslint-disable-next-line prefer-arrow-callback
    (MockOutboundQueueCtor as unknown as ReturnType<typeof vi.fn>).mockImplementation(function (
      _messenger: unknown,
      chatJid: string,
    ) {
      constructedFor.push(chatJid);
      return mockQueue;
    });

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date().toISOString(), messageCount: 0, lastMessageAt: null });

    const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
    await runtime.start();

    // Send a message from chat-a — an OutboundQueue should be created for it
    await sendAndDrainShared(runtime, makeMsg({ chatJid: 'chat-a@s.whatsapp.net', content: 'hello' }));

    expect(constructedFor).toContain('chat-a@s.whatsapp.net');
  });

  // @check CHK-066
// @traces REQ-012.AC-05
  it('shared: each chat gets its own OutboundQueue', async () => {
    const { OutboundQueue: MockOutboundQueueCtor } = await import('../../../src/runtimes/agent/outbound-queue.ts');
    const db = makeDb();
    const { messenger } = makeMessenger();

    const constructedFor: string[] = [];
    // Must use 'function' (not arrow) — arrow functions cannot be constructors
    // eslint-disable-next-line prefer-arrow-callback
    (MockOutboundQueueCtor as unknown as ReturnType<typeof vi.fn>).mockImplementation(function (
      _messenger: unknown,
      chatJid: string,
    ) {
      constructedFor.push(chatJid);
      return mockQueue;
    });

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date().toISOString(), messageCount: 0, lastMessageAt: null });

    const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
    await runtime.start();

    await sendAndDrainShared(runtime, makeMsg({ chatJid: 'chat-a@s.whatsapp.net', content: 'msg1' }));
    await sendAndDrainShared(runtime, makeMsg({ chatJid: 'chat-b@s.whatsapp.net', content: 'msg2' }));
    // Third message from chat-a — should NOT create a second queue for it
    await sendAndDrainShared(runtime, makeMsg({ chatJid: 'chat-a@s.whatsapp.net', content: 'msg3' }));

    const queuedForA = constructedFor.filter((jid) => jid === 'chat-a@s.whatsapp.net');
    const queuedForB = constructedFor.filter((jid) => jid === 'chat-b@s.whatsapp.net');
    expect(queuedForA).toHaveLength(1);
    expect(queuedForB).toHaveLength(1);
  });

  // @check CHK-067
// @traces REQ-012.AC-06
  it('shared: /new is silently ignored for non-admin senders', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({
      content: '/new',
      senderJid: '99999999@s.whatsapp.net', // not in adminPhones
    }));

    // handleNew should NOT have been called
    expect(mockSession.handleNew).not.toHaveBeenCalled();
    // No response sent
    expect(mockQueue.enqueueText).not.toHaveBeenCalled();
  });

  // @check CHK-067
// @traces REQ-012.AC-06
  it('shared: /new is allowed for admin senders', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
    await runtime.start();
    // Seed session first — use a non-turn message to ensure session is initialized
    await sendAndDrainShared(runtime, makeMsg({ content: 'hello', senderJid: '18459780919@s.whatsapp.net' }));

    mockQueue.enqueueText.mockClear();
    mockSession.handleNew.mockClear();

    await sendAndDrain(runtime, makeMsg({
      content: '/new',
      senderJid: '18459780919@s.whatsapp.net', // in adminPhones
    }));

    expect(mockSession.handleNew).toHaveBeenCalled();
    const texts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(texts.some((t) => t.includes('new session'))).toBe(true);
  });

  it('non-shared: /new is allowed for any sender (backward compat)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger); // default: shared=false
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: 'hello', senderJid: '99999999@s.whatsapp.net' }));

    await sendAndDrain(runtime, makeMsg({
      content: '/new',
      senderJid: '99999999@s.whatsapp.net', // not admin, but non-shared allows it
    }));

    expect(mockSession.handleNew).toHaveBeenCalled();
  });

  // ─── sandboxPerChat workspace isolation ────────────────────────────────────

  it('sandboxPerChat: two DMs from different JIDs produce different sessions', async () => {
    const { SessionManager: MockSessionManagerCtor } = await import('../../../src/runtimes/agent/session.ts');
    const db = makeDb();
    const { messenger } = makeMessenger();

    // Map different JIDs to different workspace keys
    mockChatJidToWorkspace.mockImplementation((_instanceCwd: string, chatJid: string) => {
      const key = chatJid.replace('@s.whatsapp.net', '');
      return { kind: 'dm' as const, workspaceKey: key, workspacePath: `/tmp/${key}` };
    });
    mockGetResumableSessionForChat.mockReturnValue(null);

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    await sendAndDrain(runtime, makeMsg({ chatJid: '111@s.whatsapp.net', content: 'hello' }));
    await sendAndDrain(runtime, makeMsg({ chatJid: '222@s.whatsapp.net', content: 'hello' }));

    // Two different sessions should have been created
    const constructorCalls = (MockSessionManagerCtor as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(constructorCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('sandboxPerChat: same person with @lid and @s.whatsapp.net variant maps to same session', async () => {
    const { SessionManager: MockSessionManagerCtor } = await import('../../../src/runtimes/agent/session.ts');
    const db = makeDb();
    const { messenger } = makeMessenger();

    // Both JID variants map to the same workspace key (phone number)
    mockChatJidToWorkspace.mockImplementation((_instanceCwd: string, _chatJid: string) => ({
      kind: 'dm' as const,
      workspaceKey: '18459780919',
      workspacePath: '/tmp/18459780919',
    }));
    mockGetResumableSessionForChat.mockReturnValue(null);

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    const constructorCallsBefore = (MockSessionManagerCtor as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    // First message via @s.whatsapp.net
    await sendAndDrain(runtime, makeMsg({ chatJid: '18459780919@s.whatsapp.net', content: 'hello' }));
    const afterFirst = (MockSessionManagerCtor as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    // Second message via @lid variant — same workspace key → should reuse existing session
    await sendAndDrain(runtime, makeMsg({ chatJid: '18459780919@lid', content: 'follow-up' }));
    const afterSecond = (MockSessionManagerCtor as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    expect(afterFirst - constructorCallsBefore).toBe(1);  // one session created
    expect(afterSecond - afterFirst).toBe(0);             // no new session on second message
  });

  it('sandboxPerChat: /new preserves workspace resources (socket server survives)', async () => {
    const { WhatSoupSocketServer: MockSocketServer } = await import('../../../src/mcp/socket-server.ts');
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockChatJidToWorkspace.mockImplementation((_instanceCwd: string, _chatJid: string) => ({
      kind: 'dm' as const,
      workspaceKey: '18459780919',
      workspacePath: '/tmp/18459780919',
    }));
    mockGetResumableSessionForChat.mockReturnValue(null);

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    // First message seeds the session + workspace resources
    await sendAndDrain(runtime, makeMsg({ chatJid: '18459780919@s.whatsapp.net', content: 'hello' }));
    const socketServerCallsAfterFirst = (MockSocketServer as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    // /new should NOT create a new socket server again (workspace resources survive)
    await sendAndDrain(runtime, makeMsg({ chatJid: '18459780919@s.whatsapp.net', content: '/new' }));
    await sendAndDrain(runtime, makeMsg({ chatJid: '18459780919@s.whatsapp.net', content: 'hello again' }));
    const socketServerCallsAfterNew = (MockSocketServer as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    expect(socketServerCallsAfterNew).toBe(socketServerCallsAfterFirst); // no new socket server started
    // session.handleNew should have been called
    expect(mockSession.handleNew).toHaveBeenCalled();
  });

  it('sandboxPerChat: delivery JID updated on each message via updateDeliveryJid', async () => {
    const { OutboundQueue: MockOutboundQueueCtor } = await import('../../../src/runtimes/agent/outbound-queue.ts');
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockChatJidToWorkspace.mockImplementation((_instanceCwd: string, _chatJid: string) => ({
      kind: 'dm' as const,
      workspaceKey: '18459780919',
      workspacePath: '/tmp/18459780919',
    }));
    mockGetResumableSessionForChat.mockReturnValue(null);

    // Track updateDeliveryJid calls
    const updateDeliveryJidCalls: string[] = [];
    (MockOutboundQueueCtor as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
      return {
        ...mockQueue,
        updateDeliveryJid: vi.fn((jid: string) => { updateDeliveryJidCalls.push(jid); }),
      };
    });

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    // First message with @s.whatsapp.net variant
    await sendAndDrain(runtime, makeMsg({ chatJid: '18459780919@s.whatsapp.net', content: 'msg1' }));
    // Second message with @lid variant
    await sendAndDrain(runtime, makeMsg({ chatJid: '18459780919@lid', content: 'msg2' }));

    // updateDeliveryJid should have been called at least twice (once per message)
    expect(updateDeliveryJidCalls.length).toBeGreaterThanOrEqual(2);
    // The calls should include both JID variants
    expect(updateDeliveryJidCalls).toContain('18459780919@s.whatsapp.net');
    expect(updateDeliveryJidCalls).toContain('18459780919@lid');
  });

  it('sandboxPerChat: start() calls backfillWorkspaceKeys and sweepOrphanedSessions', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    expect(mockBackfillWorkspaceKeys).toHaveBeenCalledWith(db, tmpdir());
    expect(mockSweepOrphanedSessions).toHaveBeenCalledWith(db);
  });

  it('sandboxPerChat: orphaned sessions are marked during start()', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const { markOrphaned: mockMarkOrphaned } = await import('../../../src/runtimes/agent/session-db.ts');

    // Simulate a session whose PID is dead (process.kill throws)
    mockSweepOrphanedSessions.mockReturnValue([{ id: 42, claude_pid: 99999999 }]);

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    expect(mockMarkOrphaned).toHaveBeenCalledWith(db, 42);
  });

  it('sandboxPerChat: eager session resume skipped on start()', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    // getActiveSession returns a resumable session
    mockGetActiveSession.mockReturnValue({
      id: 1,
      session_id: 'sess-123',
      chat_jid: 'user@s.whatsapp.net',
      claude_pid: 0,
      status: 'active',
      started_at: new Date().toISOString(),
      last_message_at: null,
      message_count: 0,
    });

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    // In sandboxPerChat mode, getActiveSession should NOT be called at start
    // (resumption is lazy, per-chat)
    expect(mockSession.spawnSession).not.toHaveBeenCalled();
  });

  it('sandboxPerChat: lazy resume called on first message when resumable session exists', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockChatJidToWorkspace.mockImplementation((_instanceCwd: string, _chatJid: string) => ({
      kind: 'dm' as const,
      workspaceKey: '18459780919',
      workspacePath: '/tmp/18459780919',
    }));

    // Resumable session exists for this workspace key
    mockGetResumableSessionForChat.mockReturnValue({
      id: 5,
      session_id: 'sess-resumed',
      chat_jid: '18459780919@s.whatsapp.net',
    });

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    expect(mockSession.spawnSession).not.toHaveBeenCalled();

    // First message triggers lazy resume
    await sendAndDrain(runtime, makeMsg({ chatJid: '18459780919@s.whatsapp.net', content: 'hello' }));

    expect(mockSession.spawnSession).toHaveBeenCalledWith('sess-resumed', 5);
  });

  it('sandboxPerChat: chat-scoped socket server provisioned with correct SessionContext', async () => {
    const { WhatSoupSocketServer: MockSocketServer } = await import('../../../src/mcp/socket-server.ts');
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockChatJidToWorkspace.mockImplementation((_instanceCwd: string, _chatJid: string) => ({
      kind: 'dm' as const,
      workspaceKey: '18459780919',
      workspacePath: '/tmp/18459780919',
    }));
    mockGetResumableSessionForChat.mockReturnValue(null);

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    // First message triggers workspace provisioning
    await sendAndDrain(runtime, makeMsg({ chatJid: '18459780919@s.whatsapp.net', content: 'hello' }));

    // WhatSoupSocketServer should have been constructed with chat-scoped session context
    const calls = (MockSocketServer as unknown as ReturnType<typeof vi.fn>).mock.calls;
    // Filter to calls made after start() (global socket server call may exist for non-sandboxPerChat mode)
    const chatScopedCall = calls.find((args: unknown[]) => {
      const ctx = args[2] as { tier: string; conversationKey?: string };
      return ctx?.tier === 'chat-scoped';
    });
    expect(chatScopedCall).toBeDefined();
    const sessionCtx = chatScopedCall![2] as { tier: string; conversationKey: string; deliveryJid: string };
    expect(sessionCtx.tier).toBe('chat-scoped');
    expect(sessionCtx.conversationKey).toBe('18459780919');
    expect(sessionCtx.deliveryJid).toBe('18459780919@s.whatsapp.net');
  });

  it('sandboxPerChat: updateDeliveryJid called on socket server when JID changes', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockChatJidToWorkspace.mockImplementation((_instanceCwd: string, _chatJid: string) => ({
      kind: 'dm' as const,
      workspaceKey: '18459780919',
      workspacePath: '/tmp/18459780919',
    }));
    mockGetResumableSessionForChat.mockReturnValue(null);

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();
    mockSocketServerInstance.updateDeliveryJid.mockClear();

    // First message via @s.whatsapp.net
    await sendAndDrain(runtime, makeMsg({ chatJid: '18459780919@s.whatsapp.net', content: 'hello' }));
    // Second message via @lid variant
    await sendAndDrain(runtime, makeMsg({ chatJid: '18459780919@lid', content: 'follow-up' }));

    // updateDeliveryJid should have been called on the socket server for each subsequent message
    expect(mockSocketServerInstance.updateDeliveryJid).toHaveBeenCalled();
    const jidArgs = mockSocketServerInstance.updateDeliveryJid.mock.calls.map((c: unknown[]) => c[0]);
    expect(jidArgs).toContain('18459780919@lid');
  });

  // ─── Per-chat shared state race regression tests ─────────────────────────────
  // Before fix: ensureSessionAndQueue mutated this.session/this.queue shared fields,
  // so /new and /status from chat A could target chat B's session if B messaged last.

  it('per_chat /status reads from correct chat session, not last-processed shared field', async () => {
    const { SessionManager: MockSessionManagerCtor } = await import('../../../src/runtimes/agent/session.ts');
    const db = makeDb();
    const { messenger, sentMessages } = makeMessenger();

    // Create distinct sessions per workspace key so we can tell them apart
    const sessionsByKey = new Map<string, ReturnType<typeof vi.fn>>();
    (MockSessionManagerCtor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      function (opts: { chatJid: string; onEvent: (event: AgentEvent) => void }) {
        const key = opts.chatJid.replace('@s.whatsapp.net', '');
        const perChatSession = {
          spawnSession: vi.fn(async () => {}),
          sendTurn: vi.fn(async () => {}),
          handleNew: vi.fn(async () => {}),
          getStatus: vi.fn(() => ({
            active: true,
            pid: parseInt(key) || 999,
            sessionId: `session-${key}`,
            startedAt: new Date().toISOString(),
            messageCount: 1,
            lastMessageAt: new Date().toISOString(),
          })),
          shutdown: vi.fn(async () => {}),
          clearTurnWatchdog: vi.fn(() => {}),
          tickWatchdog: vi.fn(() => {}),
          trackToolStart: vi.fn((_toolId: string) => {}),
          trackToolEnd: vi.fn((_toolId: string) => {}),
        };
        sessionsByKey.set(key, perChatSession);
        return perChatSession;
      },
    );

    // Each chat maps to its own workspace key
    mockChatJidToWorkspace.mockImplementation((_cwd: string, chatJid: string) => {
      const key = chatJid.replace('@s.whatsapp.net', '');
      return { kind: 'dm' as const, workspaceKey: key, workspacePath: `/tmp/${key}` };
    });
    mockGetResumableSessionForChat.mockReturnValue(null);

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    // Chat A sends a message → creates session for chat A
    await sendAndDrain(runtime, makeMsg({ chatJid: '111@s.whatsapp.net', content: 'hello from A' }));
    // Chat B sends a message → creates session for chat B
    // (OLD BUG: this would set this.session to B's session)
    await sendAndDrain(runtime, makeMsg({ chatJid: '222@s.whatsapp.net', content: 'hello from B' }));

    // Clear getStatus call tracking on both sessions
    const sessionA = sessionsByKey.get('111');
    const sessionB = sessionsByKey.get('222');
    expect(sessionA).toBeDefined();
    expect(sessionB).toBeDefined();
    sessionA!.getStatus.mockClear();
    sessionB!.getStatus.mockClear();

    // Chat A asks for /status — should query A's session, not B's
    await sendAndDrain(runtime, makeMsg({
      chatJid: '111@s.whatsapp.net',
      senderJid: '111@s.whatsapp.net',
      content: '/status',
    }));

    // getStatus should have been called on A's session, not B's
    expect(sessionA!.getStatus).toHaveBeenCalled();
    expect(sessionB!.getStatus).not.toHaveBeenCalled();
  });

  it('per_chat /new resets correct chat session, not last-processed shared field', async () => {
    const { SessionManager: MockSessionManagerCtor } = await import('../../../src/runtimes/agent/session.ts');
    const db = makeDb();
    const { messenger, sentMessages } = makeMessenger();

    // Track which session gets handleNew called
    const handleNewCalls: string[] = [];
    (MockSessionManagerCtor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      function (opts: { chatJid: string; onEvent: (event: AgentEvent) => void }) {
        const key = opts.chatJid.replace('@s.whatsapp.net', '');
        return {
          spawnSession: vi.fn(async () => {}),
          sendTurn: vi.fn(async () => {}),
          handleNew: vi.fn(async () => { handleNewCalls.push(key); }),
          getStatus: vi.fn(() => ({
            active: true, pid: parseInt(key) || 999, sessionId: `session-${key}`,
            startedAt: new Date().toISOString(), messageCount: 1, lastMessageAt: new Date().toISOString(),
          })),
          shutdown: vi.fn(async () => {}),
          clearTurnWatchdog: vi.fn(() => {}),
          tickWatchdog: vi.fn(() => {}),
          trackToolStart: vi.fn((_toolId: string) => {}),
          trackToolEnd: vi.fn((_toolId: string) => {}),
        };
      },
    );

    mockChatJidToWorkspace.mockImplementation((_cwd: string, chatJid: string) => {
      const key = chatJid.replace('@s.whatsapp.net', '');
      return { kind: 'dm' as const, workspaceKey: key, workspacePath: `/tmp/${key}` };
    });
    mockGetResumableSessionForChat.mockReturnValue(null);

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    // Chat A and B both establish sessions
    await sendAndDrain(runtime, makeMsg({ chatJid: '111@s.whatsapp.net', content: 'hello from A' }));
    await sendAndDrain(runtime, makeMsg({ chatJid: '222@s.whatsapp.net', content: 'hello from B' }));

    // Chat A sends /new — should reset A's session, not B's
    handleNewCalls.length = 0;
    sentMessages.length = 0;
    await sendAndDrain(runtime, makeMsg({
      chatJid: '111@s.whatsapp.net',
      senderJid: '18459780919@s.whatsapp.net',  // admin phone (required for /new)
      content: '/new',
    }));

    // handleNew should have been called on A's session (key '111'), not B's ('222')
    expect(handleNewCalls).toContain('111');
    expect(handleNewCalls).not.toContain('222');
  });
});
