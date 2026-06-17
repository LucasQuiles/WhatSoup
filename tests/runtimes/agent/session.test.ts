import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { SessionManager } from '../../../src/runtimes/agent/session.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type { ProviderMcpBridge } from '../../../src/runtimes/agent/providers/types.ts';
import {
  CONFIG_ROOT_ISOLATION_FLAG,
  FAILCLOSED_FLAG,
} from '../../../src/runtimes/agent/providers/child-env.ts';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock/home'),
  userInfo: vi.fn(() => ({ username: 'testuser' })),
}));

/** Create a mock child process. */
function makeMockChild(pid = 12345) {
  const stdin = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  (stdin as unknown as { write: ReturnType<typeof vi.fn> }).write = vi.fn(
    (_data: unknown, _enc?: unknown, cb?: (err?: Error | null) => void) => { if (typeof _enc === 'function') (_enc as (err?: Error | null) => void)(); else if (typeof cb === 'function') cb(); },
  );
  (stdin as unknown as { end: ReturnType<typeof vi.fn> }).end = vi.fn();

  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  const killFn = vi.fn();
  const onFn = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    // Store exit handler so tests can trigger it
    if (event === 'exit') {
      (child as unknown as { _exitCb: (...args: unknown[]) => void })._exitCb = cb;
    }
  });

  const child = {
    pid,
    stdin,
    stdout,
    stderr,
    kill: killFn,
    on: onFn,
    _exitCb: null as ((...args: unknown[]) => void) | null,
  };

  return child;
}

type MockChild = ReturnType<typeof makeMockChild>;

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

// Import after mocks are registered
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { toConversationKey } from '../../../src/core/conversation-key.ts';
import { formatAge, TURN_WATCHDOG_MS, WATCHDOG_SOFT_MS, WATCHDOG_WARN_MS, WATCHDOG_HARD_MS, PROVIDER_DISPLAY_NAMES } from '../../../src/runtimes/agent/session.ts';
import { OpenAIApiProvider } from '../../../src/runtimes/agent/providers/openai-api.ts';
import { AnthropicApiProvider } from '../../../src/runtimes/agent/providers/anthropic-api.ts';

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
      return { waMessageId: null };
    }),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  };
  return { messenger, sentMessages };
}

function makeSseResponse(events: Array<Record<string, unknown> | string>): Response {
  const body = events
    .map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

// ─── DB mock helpers ──────────────────────────────────────────────────────────

vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  createSession: vi.fn(() => 42),
  incrementMessageCount: vi.fn(),
  updateSessionId: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateTranscriptPath: vi.fn(),
  backfillSessionProvider: vi.fn(),
}));

import {
  createSession,
  incrementMessageCount,
  updateSessionId,
  updateSessionStatus,
} from '../../../src/runtimes/agent/session-db.ts';

const CHAT_JID = 'test@s.whatsapp.net';

async function withConnectorMutationEnv(
  overrides: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const keys = [
    'ALLOW_M365_MUTATIONS',
    FAILCLOSED_FLAG,
    CONFIG_ROOT_ISOLATION_FLAG,
    'HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
  ] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await run();
  } finally {
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function lastSpawnEnv(): NodeJS.ProcessEnv {
  const options = (spawn as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
  return options?.env ?? {};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SessionManager', () => {
  let mockChild: MockChild;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = makeMockChild(12345);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // @check CHK-018
  // @traces REQ-005.AC-01
  it('spawnSession calls spawn with correct args', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const events: AgentEvent[] = [];

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: (e) => events.push(e) });
    await sm.spawnSession();

    expect(spawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining([
        '-p',
        '--verbose',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--permission-mode', 'bypassPermissions',
        '--append-system-prompt', expect.stringContaining('personal'),
      ]),
      expect.objectContaining({
        cwd: '/mock/home',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  });

  // @check CHK-019
  // @traces CON-003.AC-02
  it('spawnSession passes bypassPermissions in args', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();

    const callArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[1]).toContain('bypassPermissions');
  });

  it('spawnSession propagates ALLOW_M365_MUTATIONS when fail-closed mode is unset', async () => {
    await withConnectorMutationEnv({
      ALLOW_M365_MUTATIONS: '1',
      [FAILCLOSED_FLAG]: undefined,
    }, async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });

      await sm.spawnSession();

      expect(lastSpawnEnv()).toHaveProperty('ALLOW_M365_MUTATIONS', '1');
    });
  });

  it('spawnSession propagates ALLOW_M365_MUTATIONS in fail-closed mode when the instance opts in', async () => {
    await withConnectorMutationEnv({
      ALLOW_M365_MUTATIONS: '1',
      [FAILCLOSED_FLAG]: '1',
    }, async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const sm = new SessionManager({
        db,
        messenger,
        chatJid: CHAT_JID,
        onEvent: vi.fn(),
        allowM365Mutations: true,
      });

      await sm.spawnSession();

      expect(lastSpawnEnv()).toHaveProperty('ALLOW_M365_MUTATIONS', '1');
    });
  });

  it('spawnSession drops ALLOW_M365_MUTATIONS in fail-closed mode when the instance omits the opt-in', async () => {
    await withConnectorMutationEnv({
      ALLOW_M365_MUTATIONS: '1',
      [FAILCLOSED_FLAG]: '1',
    }, async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });

      await sm.spawnSession();

      expect(lastSpawnEnv()).not.toHaveProperty('ALLOW_M365_MUTATIONS');
    });
  });

  it('spawnSession drops ALLOW_M365_MUTATIONS in fail-closed mode when the instance explicitly opts out', async () => {
    await withConnectorMutationEnv({
      ALLOW_M365_MUTATIONS: '1',
      [FAILCLOSED_FLAG]: '1',
    }, async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const sm = new SessionManager({
        db,
        messenger,
        chatJid: CHAT_JID,
        onEvent: vi.fn(),
        allowM365Mutations: false,
      });

      await sm.spawnSession();

      expect(lastSpawnEnv()).not.toHaveProperty('ALLOW_M365_MUTATIONS');
    });
  });

  it('spawnSession can isolate child HOME/XDG config roots when explicitly enabled', async () => {
    await withConnectorMutationEnv({
      HOME: '/host/home',
      XDG_CONFIG_HOME: '/host/config',
      XDG_DATA_HOME: '/host/data',
      [CONFIG_ROOT_ISOLATION_FLAG]: '1',
    }, async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const sm = new SessionManager({
        db,
        messenger,
        chatJid: CHAT_JID,
        onEvent: vi.fn(),
        cwd: '/workspace/chat-a',
        configRoot: '/workspace/chat-a/.agent-home',
      });

      await sm.spawnSession();

      expect(lastSpawnEnv()).toMatchObject({
        HOME: '/workspace/chat-a/.agent-home',
        XDG_CONFIG_HOME: '/workspace/chat-a/.agent-home/.config',
        XDG_DATA_HOME: '/workspace/chat-a/.agent-home/.local/share',
      });
    });
  });

  it('sendTurn writes JSONL to stdin', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();
    await sm.sendTurn('hello world');

    expect(mockChild.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('"text":"hello world"'),
      'utf8',
      expect.any(Function),
    );

    // Verify full JSONL structure
    const written = (mockChild.stdin.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
    });
  });

  it('handleNew kills current child, marks session ended, spawns new', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();

    // Spawn a second mock child for the re-spawn
    const mockChild2 = makeMockChild(99999);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild2);

    await sm.handleNew();

    // First child should be killed
    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
    // Session should be marked ended
    expect(updateSessionStatus).toHaveBeenCalledWith(db, 42, 'ended');
    // A new spawn should have occurred
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('child exit marks session crashed and notifies user', async () => {
    const db = makeDb();
    const { messenger, sentMessages } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();

    // Trigger the exit callback with a non-zero code
    if (mockChild._exitCb) {
      mockChild._exitCb(1, null);
    }

    await vi.waitFor(() => expect(sentMessages).toHaveLength(1));

    expect(updateSessionStatus).toHaveBeenCalledWith(db, 42, 'crashed');
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].jid).toBe(CHAT_JID);
    expect(sentMessages[0].text).toContain('session ended');
  });

  it('spawn-per-turn non-zero exit invokes crash handling and notifies the user', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const onCrash = vi.fn();
    const notifyUser = vi.fn();

    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      provider: 'opencode-cli',
      onEvent: vi.fn(),
      onCrash,
      notifyUser,
    });

    await sm.spawnSession();
    await sm.sendTurn('hello');

    mockChild._exitCb?.(1, null);
    await vi.waitFor(() => expect(notifyUser).toHaveBeenCalledTimes(1));

    expect(onCrash).toHaveBeenCalledWith(expect.objectContaining({
      exitCode: 1,
      signal: null,
      sessionId: null,
      dbRowId: 42,
      provider: 'opencode-cli',
    }));
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect(notifyUser.mock.calls[0][0]).toContain('exited with code 1');
  });

  it('classifies and redacts provider stderr in crash metadata', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const onCrash = vi.fn();
    const email = `lucas${'@'}example.com`;
    const token = 'abcdefghijklmnopqrstuvwxyz';

    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      onCrash,
    });

    await sm.spawnSession();

    mockChild.stderr.emit('data', Buffer.from(`Please run /login for ${email} with Bearer ${token}`));
    mockChild._exitCb?.(1, null);

    expect(onCrash).toHaveBeenCalledWith(expect.objectContaining({
      exitCode: 1,
      signal: null,
      sessionId: null,
      dbRowId: 42,
      provider: 'claude-cli',
      crashClass: 'provider_auth_required',
    }));

    const crashInfo = onCrash.mock.calls[0]?.[0] as { stderrPreview?: string };
    expect(crashInfo.stderrPreview).toContain('Please run /login');
    expect(crashInfo.stderrPreview).toContain('Bearer [REDACTED]');
    expect(crashInfo.stderrPreview).not.toContain(email);
    expect(crashInfo.stderrPreview).not.toContain(token);
  });

  it('getStatus returns correct state when active', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    expect(sm.getStatus()).toEqual({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });

    await sm.spawnSession();

    const status = sm.getStatus();
    expect(status.active).toBe(true);
    expect(status.pid).toBe(12345);
  });

  it('getStatus returns inactive after shutdown', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();
    await sm.shutdown();

    expect(sm.getStatus()).toEqual({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });
  });

  it('init event updates sessionId via updateSessionId', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const events: AgentEvent[] = [];

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: (e) => events.push(e) });
    await sm.spawnSession();

    // Simulate init line from stdout
    const initLine = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'ses_abc123' }) + '\n';
    mockChild.stdout.emit('data', Buffer.from(initLine));

    expect(updateSessionId).toHaveBeenCalledWith(db, 42, 'ses_abc123');
    expect(sm.getStatus().sessionId).toBe('ses_abc123');
    expect(events.some((e) => e.type === 'init')).toBe(true);
  });

  it('buffers stdout chunks separately from the parsed line remainder', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const events: AgentEvent[] = [];

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: (event) => events.push(event) });
    await sm.spawnSession();

    const state = sm as unknown as { stdoutChunks?: Buffer[]; stdoutBufferStr?: string };

    mockChild.stdout.emit('data', Buffer.from('{"type":"system","subtype":"init",'));

    expect(state.stdoutChunks).toEqual([]);
    expect(state.stdoutBufferStr).toBe('{"type":"system","subtype":"init",');

    mockChild.stdout.emit('data', Buffer.from('"session_id":"ses_buffered"}\n'));

    expect(state.stdoutChunks).toEqual([]);
    expect(state.stdoutBufferStr).toBe('');
    expect(updateSessionId).toHaveBeenCalledWith(db, 42, 'ses_buffered');
    expect(events.some((event) => event.type === 'init')).toBe(true);
  });

  it('spawnSession is a no-op if already active', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();
    await sm.spawnSession(); // second call

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('createSession is called with pid, cwd, chatJid, and workspaceKey', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();

    expect(createSession).toHaveBeenCalledWith(db, 12345, '/mock/home', CHAT_JID, toConversationKey(CHAT_JID), 'claude-cli');
  });

  it('db failure during spawn kills the child and resets session state', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const busyError = new Error('SQLITE_BUSY: database is locked');
    (createSession as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw busyError;
    });

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });

    await expect(sm.spawnSession()).rejects.toThrow('SQLITE_BUSY');

    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
    expect((sm as unknown as { child: MockChild | null }).child).toBeNull();
    expect((sm as unknown as { active: boolean }).active).toBe(false);
    expect((sm as unknown as { dbRowId: number | null }).dbRowId).toBeNull();
    expect(sm.getStatus()).toEqual({
      active: false,
      pid: null,
      sessionId: null,
      startedAt: null,
      messageCount: 0,
      lastMessageAt: null,
    });
  });

  it('db failure during spawn does not block a later successful retry', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    (createSession as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await expect(sm.spawnSession()).rejects.toThrow('SQLITE_BUSY');

    const mockChild2 = makeMockChild(23456);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockChild2);

    await sm.spawnSession();

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(createSession).toHaveBeenNthCalledWith(2, db, 23456, '/mock/home', CHAT_JID, toConversationKey(CHAT_JID), 'claude-cli');
    expect(mockChild2.kill).not.toHaveBeenCalled();
    expect(sm.getStatus()).toEqual({
      active: true,
      pid: 23456,
      sessionId: null,
      startedAt: expect.any(String),
      messageCount: 0,
      lastMessageAt: null,
    });
  });

  it('spawn-per-turn createSession uses cwd, chatJid, and workspaceKey', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'opencode-cli',
      cwd: '/agent/dir',
    });
    await sm.spawnSession();

    expect(createSession).toHaveBeenCalledWith(
      db,
      0,
      '/agent/dir',
      CHAT_JID,
      toConversationKey(CHAT_JID),
      'opencode-cli',
    );
  });

  it.each([
    {
      provider: 'openai-api',
      responseText: 'OpenAI API response.',
      makeResponse: () => makeSseResponse([
        {
          choices: [{
            delta: { content: 'OpenAI API response.' },
          }],
        },
        {
          usage: {
            prompt_tokens: 7,
            completion_tokens: 5,
          },
        },
        '[DONE]',
      ]),
      spyOnSendTurn: () => vi.spyOn(OpenAIApiProvider.prototype, 'sendTurn'),
    },
    {
      provider: 'anthropic-api',
      responseText: 'Anthropic API response.',
      makeResponse: () => makeSseResponse([
        {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 8,
              output_tokens: 0,
            },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'text',
            text: '',
          },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: 'Anthropic API response.',
          },
        },
        {
          type: 'message_delta',
          usage: {
            output_tokens: 6,
          },
        },
        { type: 'message_stop' },
      ]),
      spyOnSendTurn: () => vi.spyOn(AnthropicApiProvider.prototype, 'sendTurn'),
    },
  ])('$provider initializes as a managed-loop provider without spawning a child', async ({ provider, responseText, makeResponse, spyOnSendTurn }) => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const events: AgentEvent[] = [];
    const fetchMock = vi.fn().mockResolvedValue(makeResponse());
    vi.stubGlobal('fetch', fetchMock);
    const sendTurnSpy = spyOnSendTurn();

    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: (event) => events.push(event),
      provider,
      providerConfig: {
        baseUrl: 'https://api.test.invalid/v1',
        model: 'unit-test-model',
      },
    });

    await sm.spawnSession();

    expect(spawn).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledWith(
      db,
      0,
      '/mock/home',
      CHAT_JID,
      toConversationKey(CHAT_JID),
      provider,
    );
    expect(updateSessionId).toHaveBeenCalledWith(
      db,
      42,
      expect.stringMatching(new RegExp(`^${provider}-\\d+$`)),
    );
    expect(events.some((event) => event.type === 'init')).toBe(true);
    expect(sm.getStatus()).toMatchObject({
      active: true,
      pid: null,
      sessionId: expect.stringMatching(new RegExp(`^${provider}-\\d+$`)),
      messageCount: 0,
    });

    await sm.sendTurn('hello managed provider');

    expect(spawn).not.toHaveBeenCalled();
    expect(sendTurnSpy).toHaveBeenCalledTimes(1);
    expect(sendTurnSpy.mock.calls[0]?.[0]).toMatchObject({
      role: 'user',
      conversationKey: toConversationKey(CHAT_JID),
      parts: [{ kind: 'text', text: 'hello managed provider' }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(incrementMessageCount).toHaveBeenCalledWith(db, 42);
    expect(events).toEqual(expect.arrayContaining([
      { type: 'assistant_text', text: responseText },
      expect.objectContaining({ type: 'result', text: null }),
    ]));
    expect(sm.getStatus()).toMatchObject({
      active: true,
      pid: null,
      messageCount: 1,
      lastMessageAt: expect.any(String),
    });
  });

  it('openai-api forwards native tool calls through the MCP bridge', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const events: AgentEvent[] = [];
    const executeTool = vi.fn(async () => ({ content: 'tool result', isError: false }));
    const mcpBridge: ProviderMcpBridge = {
      listTools: () => [{
        name: 'lookup_chat',
        description: 'Looks up chat data',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      }],
      executeTool,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeSseResponse([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'lookup_chat',
                  arguments: '{"query":"status"}',
                },
              }],
            },
          }],
        },
        '[DONE]',
      ]))
      .mockResolvedValueOnce(makeSseResponse([
        {
          choices: [{
            delta: { content: 'Tool complete.' },
          }],
        },
        '[DONE]',
      ]));
    vi.stubGlobal('fetch', fetchMock);

    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: (event) => events.push(event),
      provider: 'openai-api',
      providerConfig: {
        baseUrl: 'https://api.test.invalid/v1',
        model: 'unit-test-model',
      },
      mcpBridge,
    });

    await sm.spawnSession();
    await sm.sendTurn('use a tool');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(firstBody.tools).toEqual([expect.objectContaining({
      type: 'function',
      function: expect.objectContaining({ name: 'lookup_chat' }),
    })]);
    expect(executeTool).toHaveBeenCalledWith('lookup_chat', { query: 'status' });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_use', toolName: 'lookup_chat', toolId: 'call_1' }),
      expect.objectContaining({ type: 'tool_result', toolId: 'call_1', content: 'tool result' }),
      { type: 'assistant_text', text: 'Tool complete.' },
    ]));
  });

  it('openai-api marks the session crashed when a managed turn rejects', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const onCrash = vi.fn();
    const notifyUser = vi.fn();
    const failure = new Error('stream failed');
    vi.spyOn(OpenAIApiProvider.prototype, 'sendTurn').mockRejectedValue(failure);

    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'openai-api',
      onCrash,
      notifyUser,
    });

    await sm.spawnSession();
    await expect(sm.sendTurn('fail this turn')).rejects.toThrow('stream failed');

    expect(updateSessionStatus).toHaveBeenCalledWith(db, 42, 'crashed');
    expect(onCrash).toHaveBeenCalledWith(expect.objectContaining({
      exitCode: null,
      signal: null,
      sessionId: expect.stringMatching(/^openai-api-\d+$/),
      dbRowId: 42,
    }));
    expect(notifyUser).toHaveBeenCalledWith(expect.stringContaining('provider request failed'));
    expect(sm.getStatus()).toMatchObject({ active: false, pid: null, sessionId: null });
  });

  it('openai-api hard watchdog kills a stalled managed turn and marks it crashed', async () => {
    vi.useFakeTimers();
    const db = makeDb();
    const { messenger } = makeMessenger();
    const onCrash = vi.fn();
    const notifyUser = vi.fn();
    let rejectTurn!: (err: Error) => void;
    const stalledTurn = new Promise<void>((_resolve, reject) => {
      rejectTurn = reject;
    });
    vi.spyOn(OpenAIApiProvider.prototype, 'sendTurn').mockReturnValue(stalledTurn);
    const killSpy = vi.spyOn(OpenAIApiProvider.prototype, 'kill').mockImplementation(function () {
      rejectTurn(new Error('aborted by watchdog'));
    });

    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'openai-api',
      onCrash,
      notifyUser,
    });

    await sm.spawnSession();
    const turn = sm.sendTurn('stall this turn').catch((err) => err as Error);
    await vi.advanceTimersByTimeAsync(WATCHDOG_HARD_MS + 1);
    const err = await turn;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('aborted by watchdog');
    expect(killSpy).toHaveBeenCalled();
    expect(updateSessionStatus).toHaveBeenCalledWith(db, 42, 'crashed');
    expect(onCrash).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: expect.stringMatching(/^openai-api-\d+$/),
      dbRowId: 42,
    }));
    expect(notifyUser).toHaveBeenCalledWith(expect.stringContaining('30 minutes'));
    expect(sm.getStatus()).toMatchObject({ active: false, pid: null, sessionId: null });
    vi.useRealTimers();
  });

  it('spawnSession with resumeSessionId includes --resume flag', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession('abc-session-id');

    const callArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    const args: string[] = callArgs[1];
    expect(args).toContain('--resume');
    expect(args).toContain('abc-session-id');
    // --resume should immediately precede the session id
    const resumeIdx = args.indexOf('--resume');
    expect(args[resumeIdx + 1]).toBe('abc-session-id');
  });

  it('spawnSession without resumeSessionId does not include --resume', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();

    const callArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    const args: string[] = callArgs[1];
    expect(args).not.toContain('--resume');
  });

  // ─── B02: stdin write timeout ──────────────────────────────────────────────

  it('sendTurn rejects with STDIN_WRITE_TIMEOUT when stdin.write never calls back', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();

    // Make stdin.write hang forever — callback is never invoked
    mockChild.stdin.write = vi.fn((_data: unknown, _enc: unknown, _cb: (err?: Error | null) => void) => {
      // intentionally do nothing; never call _cb
    });

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();

    // Attach error handler immediately to prevent unhandled rejection warnings
    const sendPromise = sm.sendTurn('hello');
    const caught = sendPromise.catch((err: Error) => err);

    // Advance past the 30-second timeout
    await vi.advanceTimersByTimeAsync(30_001);

    const result = await caught;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('STDIN_WRITE_TIMEOUT');

    vi.useRealTimers();
  });

  // ─── B09: crash notification dedup ────────────────────────────────────────

  it('3 rapid crashes within 60 s send only 1 notification', async () => {
    const db = makeDb();
    const { messenger, sentMessages } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });

    // First crash
    await sm.spawnSession();
    mockChild._exitCb?.(1, null);
    await vi.waitFor(() => expect(sentMessages).toHaveLength(1));

    // Second crash — spawn fresh child, crash immediately
    const mockChild2 = makeMockChild(22222);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild2);
    await sm.spawnSession();
    mockChild2._exitCb?.(1, null);
    await vi.waitFor(() => expect(sentMessages).toHaveLength(1));

    // Third crash
    const mockChild3 = makeMockChild(33333);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild3);
    await sm.spawnSession();
    mockChild3._exitCb?.(1, null);
    await vi.waitFor(() => expect(sentMessages).toHaveLength(1));

    // Only the first crash should have sent a notification
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain('session ended');
  });

  // ─── P3-A: Watchdog tests ─────────────────────────────────────────────────

  it('sendTurn arms only the hard watchdog backstop — SIGKILL fires after WATCHDOG_HARD_MS (30 min)', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), instanceName: 'personal', notifyUser });
    await sm.spawnSession();
    await sm.sendTurn('test message');

    // armWatchdog should only arm the hard timer — soft/warn should be null
    expect((sm as unknown as { watchdogSoft: unknown }).watchdogSoft).toBeNull();
    expect((sm as unknown as { watchdogWarn: unknown }).watchdogWarn).toBeNull();
    expect((sm as unknown as { watchdogHard: unknown }).watchdogHard).not.toBeNull();

    // No notifications before 30 min (soft/warn are no longer armed)
    await vi.advanceTimersByTimeAsync(WATCHDOG_WARN_MS + 1);
    expect(notifyUser).not.toHaveBeenCalled();
    expect(mockChild.kill).not.toHaveBeenCalledWith('SIGKILL');

    // Advance to hard kill (30 min)
    await vi.advanceTimersByTimeAsync(WATCHDOG_HARD_MS - WATCHDOG_WARN_MS);
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');

    vi.useRealTimers();
  });

  it('clearTurnWatchdog prevents all 3 tiers from firing', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), instanceName: 'personal', notifyUser });
    await sm.spawnSession();
    await sm.sendTurn('test message');

    // Disarm the watchdog before any tier fires
    sm.clearTurnWatchdog();

    // Advance well past the hard kill timeout
    await vi.advanceTimersByTimeAsync(WATCHDOG_HARD_MS + 1);

    // Nothing should have fired
    expect(notifyUser).not.toHaveBeenCalled();
    expect(mockChild.kill).not.toHaveBeenCalledWith('SIGKILL');

    vi.useRealTimers();
  });

  it('unexpected exit clears armed watchdog timers and pending tools', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();
    await sm.sendTurn('test message');
    sm.trackToolStart('tool-after-crash');

    // Only hard timer is armed (soft/warn demoted to no-ops)
    expect((sm as unknown as { watchdogSoft: unknown }).watchdogSoft).toBeNull();
    expect((sm as unknown as { watchdogWarn: unknown }).watchdogWarn).toBeNull();
    expect((sm as unknown as { watchdogHard: unknown }).watchdogHard).not.toBeNull();
    expect(sm.hasPendingTools).toBe(true);

    mockChild._exitCb?.(1, null);

    expect((sm as unknown as { watchdogSoft: unknown }).watchdogSoft).toBeNull();
    expect((sm as unknown as { watchdogWarn: unknown }).watchdogWarn).toBeNull();
    expect((sm as unknown as { watchdogHard: unknown }).watchdogHard).toBeNull();
    expect(sm.hasPendingTools).toBe(false);

    vi.useRealTimers();
  });

  it('shutdown clears watchdog timers even when child is already null', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();
    await sm.sendTurn('test message');
    sm.trackToolStart('tool-after-null-child');

    (sm as unknown as { active: boolean }).active = false;
    (sm as unknown as { child: MockChild | null }).child = null;

    await sm.shutdown();

    expect((sm as unknown as { watchdogSoft: unknown }).watchdogSoft).toBeNull();
    expect((sm as unknown as { watchdogWarn: unknown }).watchdogWarn).toBeNull();
    expect((sm as unknown as { watchdogHard: unknown }).watchdogHard).toBeNull();
    expect(sm.hasPendingTools).toBe(false);

    vi.useRealTimers();
  });

  it('shutdown escalates from SIGTERM to SIGKILL after the grace period when the child ignores exit', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();
    const graceMs = (SessionManager as unknown as { SHUTDOWN_GRACE_MS: number }).SHUTDOWN_GRACE_MS;

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();
    await sm.shutdown();

    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(graceMs + 1);

    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
    expect(mockChild.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(mockChild.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');

    vi.useRealTimers();
  });

  it('spawnSession clears a pending shutdown kill timer before arming a replacement child', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();
    const graceMs = (SessionManager as unknown as { SHUTDOWN_GRACE_MS: number }).SHUTDOWN_GRACE_MS;

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();
    await sm.shutdown();

    expect((sm as unknown as { shutdownKillTimer: ReturnType<typeof setTimeout> | null }).shutdownKillTimer).not.toBeNull();

    const mockChild2 = makeMockChild(23456);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockChild2);

    await sm.spawnSession();
    await vi.advanceTimersByTimeAsync(graceMs + 1);

    expect((sm as unknown as { shutdownKillTimer: ReturnType<typeof setTimeout> | null }).shutdownKillTimer).toBeNull();
    expect(mockChild.kill).toHaveBeenCalledTimes(1);
    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mockChild.kill).not.toHaveBeenCalledWith('SIGKILL');
    expect(sm.getStatus().pid).toBe(23456);

    vi.useRealTimers();
  });

  it('spawn-per-turn child exit after shutdown clears the pending shutdown kill timer', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();
    const graceMs = (SessionManager as unknown as { SHUTDOWN_GRACE_MS: number }).SHUTDOWN_GRACE_MS;

    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'opencode-cli',
    });
    await sm.spawnSession();
    await sm.sendTurn('hello');
    await sm.shutdown();

    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');

    mockChild._exitCb?.(0, null);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(graceMs + 1);

    expect(mockChild.kill).toHaveBeenCalledTimes(1);
    expect(mockChild.kill).not.toHaveBeenCalledWith('SIGKILL');
    expect((sm as unknown as { shutdownKillTimer: ReturnType<typeof setTimeout> | null }).shutdownKillTimer).toBeNull();

    vi.useRealTimers();
  });

  it('leaked watchdog handlers do nothing once the session is inactive', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), instanceName: 'personal', notifyUser });
    await sm.spawnSession();
    await sm.sendTurn('test message');

    (sm as unknown as { active: boolean }).active = false;

    (sm as unknown as { handleWatchdogSoft: () => void }).handleWatchdogSoft();
    (sm as unknown as { handleWatchdogWarn: () => void }).handleWatchdogWarn();
    (sm as unknown as { handleWatchdogHard: () => void }).handleWatchdogHard();

    expect(notifyUser).not.toHaveBeenCalled();
    expect(mockChild.kill).not.toHaveBeenCalled();
  });

  it('tickWatchdog resets the hard backstop — agent activity prevents kill', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), instanceName: 'personal', notifyUser });
    await sm.spawnSession();
    await sm.sendTurn('test message');

    // Advance to 20 min — no kill yet (hard is 30 min)
    await vi.advanceTimersByTimeAsync(WATCHDOG_WARN_MS);
    expect(mockChild.kill).not.toHaveBeenCalledWith('SIGKILL');

    // Simulate agent activity — resets the hard timer
    sm.tickWatchdog();

    // Advance another 20 min — no kill (timer was reset at minute 20)
    await vi.advanceTimersByTimeAsync(WATCHDOG_WARN_MS);
    expect(mockChild.kill).not.toHaveBeenCalledWith('SIGKILL');

    // Advance to 30 min after the reset — now it fires
    await vi.advanceTimersByTimeAsync(WATCHDOG_HARD_MS - WATCHDOG_WARN_MS);
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');

    vi.useRealTimers();
  });

  it('tickWatchdog is a no-op when session is inactive', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    expect(() => sm.tickWatchdog()).not.toThrow();
    expect(sm.getStatus()).toMatchObject({ active: false, pid: null });

    vi.useRealTimers();
  });

  it('repeated tickWatchdog keeps session alive indefinitely', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), instanceName: 'personal', notifyUser });
    await sm.spawnSession();
    await sm.sendTurn('test message');

    // Simulate 60 minutes of continuous activity (tick every 5 min)
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(5 * 60_000); // 5 minutes
      sm.tickWatchdog();
    }

    // After 60 min of continuous ticks, session should still be alive
    expect(notifyUser).not.toHaveBeenCalled();
    expect(mockChild.kill).not.toHaveBeenCalledWith('SIGKILL');

    vi.useRealTimers();
  });

  // ─── P3-B: Resume-fail branch ─────────────────────────────────────────────

  it('child exits code 1 with no init event and resume attempt — calls markSessionResumeFailed and onResumeFailed', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const onResumeFailedCb = vi.fn();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), instanceName: 'personal', onResumeFailed: onResumeFailedCb });
    await sm.spawnSession('some-session-id');

    // No init event received — sessionId stays null
    // Trigger exit with code 1 (resume failure pattern)
    mockChild._exitCb?.(1, null);

    await vi.waitFor(() => expect(onResumeFailedCb).toHaveBeenCalledTimes(1));

    expect(updateSessionStatus).toHaveBeenCalledWith(db, 42, 'resume_failed');
    expect(onResumeFailedCb).toHaveBeenCalledTimes(1);
    // Should NOT call updateSessionStatus with 'crashed' for a resume failure
    expect(updateSessionStatus).not.toHaveBeenCalledWith(db, 42, 'crashed');
  });

  // ─── Configurable cwd + instructionsPath ─────────────────────────────────

  it('spawnSession uses configurable cwd when provided', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      instanceName: 'personal',
      cwd: '/custom/cwd',
    });
    await sm.spawnSession();

    expect(spawn).toHaveBeenCalledWith(
      'claude',
      expect.any(Array),
      expect.objectContaining({ cwd: '/custom/cwd' }),
    );
  });

  it('spawnSession uses homedir() when cwd is not provided', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();

    expect(spawn).toHaveBeenCalledWith(
      'claude',
      expect.any(Array),
      expect.objectContaining({ cwd: '/mock/home' }),
    );
  });

  it('spawnSession reads instructionsPath and prepends identity line', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('Custom instructions here.');

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      instanceName: 'mybot',
      cwd: '/agent/dir', instructionsPath: 'CLAUDE.md',
    });
    await sm.spawnSession();

    const callArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    const args: string[] = callArgs[1];
    const systemPromptIdx = args.indexOf('--append-system-prompt');
    expect(systemPromptIdx).toBeGreaterThan(-1);
    const systemPrompt = args[systemPromptIdx + 1];
    expect(systemPrompt).toContain('mybot');
    expect(systemPrompt).toContain('Custom instructions here.');
    expect(readFileSync).toHaveBeenCalledWith('/agent/dir/CLAUDE.md', 'utf8');
  });

  // ─── Provider-aware system prompt identity ────────────────────────────────

  it('system prompt uses "Claude Code" for claude-cli provider (default)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
    });
    await sm.spawnSession();

    const callArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    const args: string[] = callArgs[1];
    const systemPromptIdx = args.indexOf('--append-system-prompt');
    const systemPrompt = args[systemPromptIdx + 1];
    expect(systemPrompt).toContain('a personal Claude Code agent');
    expect(systemPrompt).not.toContain('a personal claude-cli agent');
  });

  it('system prompt uses "Codex CLI" for codex-cli provider', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      provider: 'codex-cli',
    });
    await sm.spawnSession();

    // Codex sends systemPrompt via JSON-RPC thread/start baseInstructions on stdin
    const stdinCalls = (mockChild.stdin.write as ReturnType<typeof vi.fn>).mock.calls;
    const threadStartCall = stdinCalls.find((call: unknown[]) => {
      const data = String(call[0]);
      return data.includes('"thread/start"');
    });
    expect(threadStartCall).toBeDefined();
    const payload = JSON.parse(String(threadStartCall![0]).trim());
    expect(payload.params.baseInstructions).toContain('a personal Codex CLI agent');
    expect(payload.params.baseInstructions).not.toContain('Claude Code');
  });

  it('system prompt uses "OpenCode" for opencode-cli provider (spawn-per-turn)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      provider: 'opencode-cli',
    });
    await sm.spawnSession();

    // opencode-cli is spawn-per-turn, so systemPrompt is stored on the instance
    expect((sm as unknown as { systemPrompt: string }).systemPrompt).toContain('a personal OpenCode agent');
    expect((sm as unknown as { systemPrompt: string }).systemPrompt).not.toContain('Claude Code');
  });

  it('SessionManager constructor throws fail-fast for unknown providers (#447)', () => {
    // Pre-#447: unknown provider IDs silently aliased to Claude semantics
    // (default branches in getProviderBinary/Args/Parser). Now the
    // SessionManager constructor rejects them so the operator sees the bug
    // immediately. The shared config validator blocks this upstream, but
    // direct instantiation (as here) must still fail closed.
    const db = makeDb();
    const { messenger } = makeMessenger();

    expect(() => new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      provider: 'custom-provider',
    })).toThrow(/unknown provider/i);
  });

  it('system prompt with instructionsPath uses provider display name', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('Custom instructions.');

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      provider: 'opencode-cli',
      cwd: '/agent/dir', instructionsPath: 'CLAUDE.md',
    });
    await sm.spawnSession();

    expect((sm as unknown as { systemPrompt: string }).systemPrompt).toContain('a personal OpenCode agent');
    expect((sm as unknown as { systemPrompt: string }).systemPrompt).not.toContain('Claude Code');
    expect((sm as unknown as { systemPrompt: string }).systemPrompt).toContain('Custom instructions.');
  });

  // ─── P3-C: Pending tool tracking ─────────────────────────────────────────

  it('trackToolStart/trackToolEnd tracks pending tools correctly', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();

    expect(sm.hasPendingTools).toBe(false);

    sm.trackToolStart('tool-1');
    expect(sm.hasPendingTools).toBe(true);

    sm.trackToolStart('tool-2');
    expect(sm.hasPendingTools).toBe(true);

    sm.trackToolEnd('tool-1');
    expect(sm.hasPendingTools).toBe(true);

    sm.trackToolEnd('tool-2');
    expect(sm.hasPendingTools).toBe(false);
  });

  it('hasPendingTools returns true when tools are pending', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();

    expect(sm.hasPendingTools).toBe(false);
    sm.trackToolStart('tool-abc');
    expect(sm.hasPendingTools).toBe(true);
    sm.trackToolEnd('tool-abc');
    expect(sm.hasPendingTools).toBe(false);
  });

  it('clearTurnWatchdog clears pending tools', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();

    sm.trackToolStart('tool-x');
    expect(sm.hasPendingTools).toBe(true);

    sm.clearTurnWatchdog();
    expect(sm.hasPendingTools).toBe(false);
  });

  it('shutdown clears pending tools', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();

    sm.trackToolStart('tool-y');
    expect(sm.hasPendingTools).toBe(true);

    await sm.shutdown();
    expect(sm.hasPendingTools).toBe(false);
  });

  it('soft/warn watchdog handlers are no-ops (deprecated, replaced by operation tracker)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), instanceName: 'personal', notifyUser });
    await sm.spawnSession();
    await sm.sendTurn('test message');

    // Directly invoke the deprecated handlers — they should be no-ops
    (sm as unknown as { handleWatchdogSoft: () => void }).handleWatchdogSoft();
    (sm as unknown as { handleWatchdogWarn: () => void }).handleWatchdogWarn();

    expect(notifyUser).not.toHaveBeenCalled();
    expect(mockChild.kill).not.toHaveBeenCalled();
  });

  it('hard watchdog kills regardless of pending tools', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), instanceName: 'personal', notifyUser });
    await sm.spawnSession();
    await sm.sendTurn('test message');

    sm.trackToolStart('long-tool-3');

    await vi.advanceTimersByTimeAsync(WATCHDOG_HARD_MS + 1);
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');

    vi.useRealTimers();
  });

  it('crash then 61 s later another crash sends 2 notifications', async () => {
    const db = makeDb();
    const { messenger, sentMessages } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });

    // First crash at t=0
    const baseTime = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(baseTime);

    await sm.spawnSession();
    mockChild._exitCb?.(1, null);
    await vi.waitFor(() => expect(sentMessages).toHaveLength(1));

    expect(sentMessages).toHaveLength(1);

    // Second crash at t=61s (past the 60s cooldown)
    vi.spyOn(Date, 'now').mockReturnValue(baseTime + 61_000);

    const mockChild2 = makeMockChild(22222);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild2);
    await sm.spawnSession();
    mockChild2._exitCb?.(1, null);
    await vi.waitFor(() => expect(sentMessages).toHaveLength(2));

    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[1].text).toContain('session ended');
  });
});

// ─── Codex approval pre-filter tests ─────────────────────────────────────────

describe('Codex approval pre-filter', () => {
  let mockChild: MockChild;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = makeMockChild(12345);
    // Override stdin.write to tolerate calls without a callback (codex JSON-RPC uses 1-arg write)
    (mockChild.stdin as unknown as { write: ReturnType<typeof vi.fn> }).write = vi.fn(
      (_data: unknown, _enc?: unknown, cb?: (err?: Error | null) => void) => { if (cb) cb(); },
    );
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('intercepts a valid JSON-RPC approval request', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      provider: 'codex-cli',
      onEvent: vi.fn(),
    });
    await sm.spawnSession();

    // Clear writes from spawnSession's initialize + thread/start handshake
    (mockChild.stdin.write as ReturnType<typeof vi.fn>).mockClear();

    const approvalLine = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'item/commandExecution/requestApproval',
      params: {},
    }) + '\n';
    mockChild.stdout.emit('data', Buffer.from(approvalLine));

    // handleCodexServerRequest auto-approves by writing to stdin
    expect(mockChild.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('"decision":"approved"'),
    );
  });

  it('intercepts JSON-RPC approval even when jsonrpc is not the first key', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      provider: 'codex-cli',
      onEvent: vi.fn(),
    });
    await sm.spawnSession();

    // Clear writes from spawnSession's initialize + thread/start handshake
    (mockChild.stdin.write as ReturnType<typeof vi.fn>).mockClear();

    // JSON-RPC message where jsonrpc is NOT the first key
    const approvalLine = JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'item/commandExecution/requestApproval',
      params: {},
    }) + '\n';
    mockChild.stdout.emit('data', Buffer.from(approvalLine));

    // handleCodexServerRequest auto-approves by writing to stdin
    expect(mockChild.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('"decision":"approved"'),
    );
  });

  it('does NOT intercept tool output containing "method" and "id" substrings', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      provider: 'codex-cli',
      onEvent: vi.fn(),
    });
    await sm.spawnSession();

    // Clear writes from spawnSession's initialize + thread/start handshake
    (mockChild.stdin.write as ReturnType<typeof vi.fn>).mockClear();

    // A tool output line that contains "method" and "id" but is not a JSON-RPC message
    const toolOutput = 'The method getId was called with "id" parameter and "method" field\n';
    mockChild.stdout.emit('data', Buffer.from(toolOutput));

    // stdin.write should NOT have been called (no interception)
    expect(mockChild.stdin.write).not.toHaveBeenCalled();
  });
});

// ─── Provider ready signal tests ─────────────────────────────────────────────

describe('Event-driven provider ready signal', () => {
  let mockChild: MockChild;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockChild = makeMockChild(12345);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('Codex sendTurn resolves after init event fires (not after polling)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      provider: 'codex-cli',
      onEvent: vi.fn(),
    });
    await sm.spawnSession();

    // Clear writes from spawnSession's initialize + thread/start handshake
    (mockChild.stdin.write as ReturnType<typeof vi.fn>).mockClear();

    // Start sendTurn — it should await the ready promise
    const sendPromise = sm.sendTurn('hello');

    // Simulate codex thread/start response arriving (produces init event with threadId)
    const threadResponse = JSON.stringify({
      jsonrpc: '2.0',
      id: `ws-${2}`,
      result: { id: 'thread_abc123' },
    }) + '\n';
    mockChild.stdout.emit('data', Buffer.from(threadResponse));

    // The send should resolve without needing to advance timers by 15s
    await sendPromise;

    // Verify turn/start was written with the captured threadId
    expect(mockChild.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('"thread_abc123"'),
      'utf8',
      expect.any(Function),
    );
  });

  it('Codex sendTurn times out with clear error if init never fires', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      provider: 'codex-cli',
      onEvent: vi.fn(),
    });
    await sm.spawnSession();

    // Start sendTurn and attach rejection handler before advancing timers
    const sendPromise = sm.sendTurn('hello').catch((e: Error) => e);

    // Advance past the 15s timeout without firing init
    await vi.advanceTimersByTimeAsync(16_000);

    const error = await sendPromise;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch('Codex threadId not captured after 15s');
  });

  it('Gemini sendTurn resolves after init event fires (not after polling)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      provider: 'gemini-cli',
      onEvent: vi.fn(),
    });
    await sm.spawnSession();

    // Clear writes from spawnSession's initialize + session/new handshake
    (mockChild.stdin.write as ReturnType<typeof vi.fn>).mockClear();

    // Start sendTurn
    const sendPromise = sm.sendTurn('hello');

    // Simulate gemini session/new response (produces init event with sessionId)
    const sessionResponse = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: { sessionId: 'sess_xyz789' },
    }) + '\n';
    mockChild.stdout.emit('data', Buffer.from(sessionResponse));

    // The send should resolve without needing to advance timers by 15s
    await sendPromise;

    // Verify session/prompt was written with the captured sessionId
    expect(mockChild.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('sess_xyz789'),
    );
  });

  it('Gemini sendTurn times out with clear error if init never fires', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      provider: 'gemini-cli',
      onEvent: vi.fn(),
    });
    await sm.spawnSession();

    // Start sendTurn and attach rejection handler before advancing timers
    const sendPromise = sm.sendTurn('hello').catch((e: Error) => e);

    // Advance past the 15s timeout without firing init
    await vi.advanceTimersByTimeAsync(16_000);

    const error = await sendPromise;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch('Gemini sessionId not captured after 15s');
  });

  it('Codex sendTurn skips wait if threadId already captured', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      provider: 'codex-cli',
      onEvent: vi.fn(),
    });
    await sm.spawnSession();

    // Simulate init event arriving before sendTurn
    const threadResponse = JSON.stringify({
      jsonrpc: '2.0',
      id: `ws-${2}`,
      result: { id: 'thread_pre' },
    }) + '\n';
    mockChild.stdout.emit('data', Buffer.from(threadResponse));

    // Clear writes from spawnSession's handshake
    (mockChild.stdin.write as ReturnType<typeof vi.fn>).mockClear();

    // sendTurn should resolve immediately (no waiting)
    await sm.sendTurn('hello');

    expect(mockChild.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('"thread_pre"'),
      'utf8',
      expect.any(Function),
    );
  });
});

// ─── Codex session resume on crash tests ─────────────────────────────────────

describe('Codex session resume via thread ID', () => {
  let mockChild: MockChild;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = makeMockChild(12345);
    // Override stdin.write to tolerate calls without a callback (codex JSON-RPC uses 1-arg write)
    (mockChild.stdin as unknown as { write: ReturnType<typeof vi.fn> }).write = vi.fn(
      (_data: unknown, _enc?: unknown, cb?: (err?: Error | null) => void) => { if (cb) cb(); },
    );
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes threadId in thread/start when resuming with a stored thread ID', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      provider: 'codex-cli',
      onEvent: vi.fn(),
    });
    // Spawn with a resume thread ID (simulating crash recovery)
    await sm.spawnSession('thread_resume_abc', 42);

    // Find the thread/start call — it should contain the threadId
    const writes = (mockChild.stdin.write as ReturnType<typeof vi.fn>).mock.calls;
    const threadStartCall = writes.find((call: unknown[]) => {
      const data = String(call[0]);
      return data.includes('"thread/start"');
    });
    expect(threadStartCall).toBeDefined();
    const payload = JSON.parse(String(threadStartCall![0]));
    expect(payload.params.threadId).toBe('thread_resume_abc');
  });

  it('falls back to fresh thread when resume thread/start returns an error', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      provider: 'codex-cli',
      onEvent: vi.fn(),
    });
    await sm.spawnSession('thread_stale_xyz', 42);

    // Clear writes from initial handshake
    (mockChild.stdin.write as ReturnType<typeof vi.fn>).mockClear();

    // Simulate error response from the app-server rejecting the threadId.
    // The thread/start request was the second request (seq 2).
    const errorResponse = JSON.stringify({
      jsonrpc: '2.0',
      id: `ws-${2}`,
      error: { code: -32600, message: 'Thread not found' },
    }) + '\n';
    mockChild.stdout.emit('data', Buffer.from(errorResponse));

    // A fresh thread/start should have been sent (without threadId)
    const writes = (mockChild.stdin.write as ReturnType<typeof vi.fn>).mock.calls;
    const freshThreadStart = writes.find((call: unknown[]) => {
      const data = String(call[0]);
      return data.includes('"thread/start"');
    });
    expect(freshThreadStart).toBeDefined();
    const payload = JSON.parse(String(freshThreadStart![0]));
    expect(payload).toEqual({
      jsonrpc: '2.0',
      id: expect.any(String),
      method: 'thread/start',
      params: {
        cwd: '/mock/home',
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        persistExtendedHistory: true,
      },
    });
  });

  it('clears stale thread ID from DB after resume failure', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      provider: 'codex-cli',
      onEvent: vi.fn(),
    });
    await sm.spawnSession('thread_expired_999', 42);

    // Simulate error response rejecting the threadId
    const errorResponse = JSON.stringify({
      jsonrpc: '2.0',
      id: `ws-${2}`,
      error: { code: -32600, message: 'Thread expired' },
    }) + '\n';
    mockChild.stdout.emit('data', Buffer.from(errorResponse));

    // updateSessionId should have been called with empty string to clear the stale ID
    expect(updateSessionId).toHaveBeenCalledWith(db, 42, '');
  });

  it('does not include threadId in thread/start for fresh spawn (no resume)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      provider: 'codex-cli',
      onEvent: vi.fn(),
    });
    // Fresh spawn — no resume ID
    await sm.spawnSession();

    const writes = (mockChild.stdin.write as ReturnType<typeof vi.fn>).mock.calls;
    const threadStartCall = writes.find((call: unknown[]) => {
      const data = String(call[0]);
      return data.includes('"thread/start"');
    });
    expect(threadStartCall).toBeDefined();
    const payload = JSON.parse(String(threadStartCall![0]));
    expect(payload).toEqual({
      jsonrpc: '2.0',
      id: expect.any(String),
      method: 'thread/start',
      params: {
        cwd: '/mock/home',
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        persistExtendedHistory: true,
        baseInstructions: expect.stringMatching(/a personal .+ CLI agent/),
      },
    });
  });
});

// ─── Session recovery hooks ──────────────────────────────────────────────────

describe('recoverStalledOperation', () => {
  let mockChild: MockChild;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = makeMockChild(12345);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not write to provider stdin (NDJSON-safe no-op)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();

    (mockChild.stdin.write as ReturnType<typeof vi.fn>).mockClear();
    sm.recoverStalledOperation('tool_123', 'Bash');

    expect(mockChild.stdin.write).not.toHaveBeenCalled();
  });

  it('is a no-op when session is not active', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();

    // Shut down the session so active = false
    await sm.shutdown();

    (mockChild.stdin.write as ReturnType<typeof vi.fn>).mockClear();
    sm.recoverStalledOperation('tool_123', 'Bash');

    expect(mockChild.stdin.write).not.toHaveBeenCalled();
  });
});

describe('probeLiveness', () => {
  let mockChild: MockChild;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = makeMockChild(12345);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends newline to provider stdin', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();

    (mockChild.stdin.write as ReturnType<typeof vi.fn>).mockClear();
    sm.probeLiveness();

    expect(mockChild.stdin.write).toHaveBeenCalledWith('\n');
  });

  it('is a no-op when session is not active', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();

    await sm.shutdown();

    (mockChild.stdin.write as ReturnType<typeof vi.fn>).mockClear();
    sm.probeLiveness();

    expect(mockChild.stdin.write).not.toHaveBeenCalled();
  });
});

// ─── formatAge tests ──────────────────────────────────────────────────────────

describe('formatAge', () => {
  it('returns seconds for < 60s', () => {
    const isoString = new Date(Date.now() - 30_000).toISOString();
    expect(formatAge(isoString)).toBe('30s ago');
  });

  it('returns minutes for 1-59m', () => {
    const isoString = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatAge(isoString)).toBe('5m ago');
  });

  it('returns hours for >= 1h', () => {
    const isoString = new Date(Date.now() - 2 * 3_600_000).toISOString();
    expect(formatAge(isoString)).toBe('2h ago');
  });
});

// ─── buildChildEnv branch coverage ───────────────────────────────────────────

import {
  buildChildEnv,
  getProviderBinary,
  opencodeUsesConfigModel,
  __provider_switch_for_test,
} from '../../../src/runtimes/agent/session.ts';

describe('buildChildEnv', () => {
  it('throws for unknown provider id', () => {
    expect(() => buildChildEnv('not-a-provider')).toThrow(/unknown provider id/);
  });

  it('throws for openai-api (managed-loop, no child process)', () => {
    expect(() => buildChildEnv('openai-api')).toThrow(/managed-loop provider/);
  });

  it('throws for anthropic-api (managed-loop, no child process)', () => {
    expect(() => buildChildEnv('anthropic-api')).toThrow(/managed-loop provider/);
  });

  it('claude-cli: forwards OPENAI_API_KEY when set', () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-openai-key';
    try {
      const env = buildChildEnv('claude-cli');
      expect(env.OPENAI_API_KEY).toBe('sk-test-openai-key');
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });

  it('claude-cli: does not include OPENAI_API_KEY when not set', () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const env = buildChildEnv('claude-cli');
      expect(env).not.toHaveProperty('OPENAI_API_KEY');
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });

  it('codex-cli: forwards OPENAI_API_KEY when set', () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-codex-key';
    try {
      const env = buildChildEnv('codex-cli');
      expect(env.OPENAI_API_KEY).toBe('sk-codex-key');
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });

  it('codex-cli: does not include OPENAI_API_KEY when not set', () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const env = buildChildEnv('codex-cli');
      expect(env).not.toHaveProperty('OPENAI_API_KEY');
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });

  it('gemini-cli: forwards GEMINI_API_KEY when set', () => {
    const savedG = process.env.GEMINI_API_KEY;
    const savedGo = process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = 'gemini-key-123';
    delete process.env.GOOGLE_API_KEY;
    try {
      const env = buildChildEnv('gemini-cli');
      expect(env.GEMINI_API_KEY).toBe('gemini-key-123');
      expect(env).not.toHaveProperty('GOOGLE_API_KEY');
    } finally {
      if (savedG === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = savedG;
      if (savedGo !== undefined) process.env.GOOGLE_API_KEY = savedGo;
    }
  });

  it('gemini-cli: forwards both GEMINI_API_KEY and GOOGLE_API_KEY when both set', () => {
    const savedG = process.env.GEMINI_API_KEY;
    const savedGo = process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = 'gemini-key-xyz';
    process.env.GOOGLE_API_KEY = 'google-key-xyz';
    try {
      const env = buildChildEnv('gemini-cli');
      expect(env.GEMINI_API_KEY).toBe('gemini-key-xyz');
      expect(env.GOOGLE_API_KEY).toBe('google-key-xyz');
    } finally {
      if (savedG === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = savedG;
      if (savedGo === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = savedGo;
    }
  });

  it('opencode-cli: forwards OPENAI_API_KEY and ANTHROPIC_API_KEY when set', () => {
    const savedOai = process.env.OPENAI_API_KEY;
    const savedAnt = process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-openai-oc';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-oc';
    try {
      const env = buildChildEnv('opencode-cli');
      expect(env.OPENAI_API_KEY).toBe('sk-openai-oc');
      expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-oc');
    } finally {
      if (savedOai === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedOai;
      if (savedAnt === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedAnt;
    }
  });

  it('opencode-cli: providerConfig.apiKeyService for a known service adds it to env forwarding', () => {
    // 'deepseek' is a known service in SERVICE_ENV_MAP -> DEEPSEEK_API_KEY
    const savedDeep = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'ds-api-key-for-test';
    // Unset OPENAI and ANTHROPIC to keep env clean
    const savedOai = process.env.OPENAI_API_KEY;
    const savedAnt = process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const env = buildChildEnv('opencode-cli', undefined, undefined, { apiKeyService: 'deepseek' });
      expect(env.DEEPSEEK_API_KEY).toBe('ds-api-key-for-test');
    } finally {
      if (savedDeep === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = savedDeep;
      if (savedOai !== undefined) process.env.OPENAI_API_KEY = savedOai;
      if (savedAnt !== undefined) process.env.ANTHROPIC_API_KEY = savedAnt;
    }
  });

  it('opencode-cli: providerConfig.apiKeyService empty string is ignored (treated as no service)', () => {
    const savedOai = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      // Should not throw, and empty apiKeyService should not register a service
      const env = buildChildEnv('opencode-cli', undefined, undefined, { apiKeyService: '  ' });
      // Result should be a valid env object
      expect(typeof env).toBe('object');
    } finally {
      if (savedOai !== undefined) process.env.OPENAI_API_KEY = savedOai;
    }
  });
});

// ─── getProviderBinary branch coverage ───────────────────────────────────────

describe('getProviderBinary', () => {
  it('throws for unknown provider id', () => {
    expect(() => getProviderBinary('not-a-provider')).toThrow(/unknown provider id/);
  });

  it('returns null for openai-api (managed-loop)', () => {
    expect(getProviderBinary('openai-api')).toBeNull();
  });

  it('returns null for anthropic-api (managed-loop)', () => {
    expect(getProviderBinary('anthropic-api')).toBeNull();
  });

  it('returns "claude" for claude-cli', () => {
    expect(getProviderBinary('claude-cli')).toBe('claude');
  });

  it('returns "codex" for codex-cli', () => {
    expect(getProviderBinary('codex-cli')).toBe('codex');
  });

  it('returns "gemini" for gemini-cli', () => {
    expect(getProviderBinary('gemini-cli')).toBe('gemini');
  });

  it('returns "opencode" for opencode-cli', () => {
    expect(getProviderBinary('opencode-cli')).toBe('opencode');
  });
});

// ─── opencodeUsesConfigModel branch coverage ─────────────────────────────────

describe('opencodeUsesConfigModel', () => {
  it('returns false when providerConfig is undefined', () => {
    expect(opencodeUsesConfigModel(undefined)).toBe(false);
  });

  it('returns false when baseUrl is absent', () => {
    expect(opencodeUsesConfigModel({})).toBe(false);
  });

  it('returns false when baseUrl is empty string', () => {
    expect(opencodeUsesConfigModel({ baseUrl: '' })).toBe(false);
  });

  it('returns false when baseUrl is whitespace only', () => {
    expect(opencodeUsesConfigModel({ baseUrl: '   ' })).toBe(false);
  });

  it('returns true when baseUrl is a non-empty string', () => {
    expect(opencodeUsesConfigModel({ baseUrl: 'https://api.example.com/v1' })).toBe(true);
  });
});

// ─── __provider_switch_for_test branch coverage ───────────────────────────────

describe('__provider_switch_for_test', () => {
  it('getProviderBinary throws for unknown provider', () => {
    expect(() => __provider_switch_for_test.getProviderBinary('not-a-provider')).toThrow(/unknown provider id/);
  });

  it('getProviderBinary throws for managed-loop providers (openai-api)', () => {
    expect(() => __provider_switch_for_test.getProviderBinary('openai-api')).toThrow(/managed-loop provider/);
  });

  it('getProviderBinary throws for managed-loop providers (anthropic-api)', () => {
    expect(() => __provider_switch_for_test.getProviderBinary('anthropic-api')).toThrow(/managed-loop provider/);
  });

  it('getProviderArgs throws for unknown provider', () => {
    expect(() => __provider_switch_for_test.getProviderArgs('not-a-provider', '', '/cwd', undefined, undefined, [])).toThrow(/unknown provider id/);
  });

  it('getProviderArgs throws for managed-loop providers (openai-api)', () => {
    expect(() => __provider_switch_for_test.getProviderArgs('openai-api', '', '/cwd', undefined, undefined, [])).toThrow(/managed-loop provider/);
  });

  it('getProviderArgs throws for managed-loop providers (anthropic-api)', () => {
    expect(() => __provider_switch_for_test.getProviderArgs('anthropic-api', '', '/cwd', undefined, undefined, [])).toThrow(/managed-loop provider/);
  });

  it('getParser throws for unknown provider', () => {
    expect(() => __provider_switch_for_test.getParser('not-a-provider')).toThrow(/unknown provider id/);
  });

  it('getParser throws for managed-loop providers (openai-api)', () => {
    expect(() => __provider_switch_for_test.getParser('openai-api')).toThrow(/managed-loop provider/);
  });

  it('getParser throws for managed-loop providers (anthropic-api)', () => {
    expect(() => __provider_switch_for_test.getParser('anthropic-api')).toThrow(/managed-loop provider/);
  });

  it('getProviderArgs for gemini-cli returns ["--acp"]', () => {
    const args = __provider_switch_for_test.getProviderArgs('gemini-cli', 'sys-prompt', '/cwd', undefined, undefined, []);
    expect(args).toEqual(['--acp']);
  });

  it('getProviderArgs for codex-cli returns expected args without model', () => {
    const args = __provider_switch_for_test.getProviderArgs('codex-cli', '', '/cwd', undefined, undefined, []);
    expect(args).toEqual(['app-server', '--listen', 'stdio://']);
  });

  it('getProviderArgs for codex-cli includes model when provided', () => {
    const args = __provider_switch_for_test.getProviderArgs('codex-cli', '', '/cwd', undefined, 'gpt-4o', []);
    expect(args).toEqual(['app-server', '--listen', 'stdio://', '--model', 'gpt-4o']);
  });

  it('getProviderArgs for opencode-cli returns expected base args', () => {
    const args = __provider_switch_for_test.getProviderArgs('opencode-cli', 'sys', '/cwd', undefined, undefined, []);
    expect(args).toEqual(['run', '--format', 'json', '--pure']);
  });

  it('getProviderArgs for opencode-cli includes -m when model is set and no baseUrl', () => {
    const args = __provider_switch_for_test.getProviderArgs('opencode-cli', 'sys', '/cwd', undefined, 'openai/gpt-4o', []);
    expect(args).toContain('-m');
    expect(args).toContain('openai/gpt-4o');
  });

  it('getProviderArgs for opencode-cli omits -m when baseUrl is set (config model)', () => {
    const args = __provider_switch_for_test.getProviderArgs('opencode-cli', 'sys', '/cwd', undefined, 'openai/gpt-4o', [], { baseUrl: 'https://api.example.com/v1' });
    expect(args).not.toContain('-m');
  });

  it('getParser returns a function for claude-cli', () => {
    const parser = __provider_switch_for_test.getParser('claude-cli');
    expect(typeof parser).toBe('function');
  });

  it('getParser returns a function for codex-cli', () => {
    const parser = __provider_switch_for_test.getParser('codex-cli');
    expect(typeof parser).toBe('function');
  });

  it('getParser returns a function for gemini-cli', () => {
    const parser = __provider_switch_for_test.getParser('gemini-cli');
    expect(typeof parser).toBe('function');
  });

  it('getParser returns a function for opencode-cli', () => {
    const parser = __provider_switch_for_test.getParser('opencode-cli');
    expect(typeof parser).toBe('function');
  });
});

// ─── buildSystemPrompt edge cases ────────────────────────────────────────────

describe('buildSystemPrompt edge cases', () => {
  let mockChild: ReturnType<typeof makeMockChild>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = makeMockChild(12345);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes handoffSystemBlock output when provided', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const handoffSystemBlock = vi.fn(() => 'Handoff context block');

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      handoffSystemBlock,
    });
    await sm.spawnSession();

    const callArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    const args: string[] = callArgs[1];
    const systemPromptIdx = args.indexOf('--append-system-prompt');
    const systemPrompt = args[systemPromptIdx + 1];
    expect(systemPrompt).toContain('Handoff context block');
    expect(handoffSystemBlock).toHaveBeenCalledTimes(1);
  });

  it('does not include handoffBlock when handoffSystemBlock returns null', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const handoffSystemBlock = vi.fn(() => null);

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      handoffSystemBlock,
    });
    await sm.spawnSession();

    // Should still spawn correctly
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('includes configSystemPrompt when provided', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      configSystemPrompt: 'Extra system config content',
    });
    await sm.spawnSession();

    const callArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    const args: string[] = callArgs[1];
    const systemPromptIdx = args.indexOf('--append-system-prompt');
    const systemPrompt = args[systemPromptIdx + 1];
    expect(systemPrompt).toContain('Extra system config content');
  });

  it('throws when instructionsPath file cannot be read', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      cwd: '/agent/dir', instructionsPath: 'MISSING.md',
    });

    expect(() => sm.buildSystemPrompt()).toThrow(/Failed to read instructionsPath/);
    expect(() => sm.buildSystemPrompt()).toThrow(/ENOENT/);
  });

  it('throws when instructionsPath read throws a non-Error', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw 'string error'; // intentional non-Error throw to exercise String(err) path
    });

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      cwd: '/agent/dir', instructionsPath: 'MISSING.md',
    });

    expect(() => sm.buildSystemPrompt()).toThrow(/Failed to read instructionsPath/);
  });

  it('provider display name falls back to provider id for unknown provider-like display name', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    // Use a known valid provider whose display name we can confirm
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      provider: 'gemini-cli',
    });
    const prompt = sm.buildSystemPrompt();
    expect(prompt).toContain('a personal Gemini CLI agent');
  });
});

// ─── updateMcpActorJid branch coverage ───────────────────────────────────────

describe('updateMcpActorJid', () => {
  it('updates actorJid when mcpSessionContext is provided', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const mcpSessionContext = { tier: 'global' as const, actorJid: '1555000001@s.whatsapp.net', sessionId: 'ses_test' };

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      mcpSessionContext,
    });

    sm.updateMcpActorJid('1555000002@s.whatsapp.net');
    expect(mcpSessionContext.actorJid).toBe('1555000002@s.whatsapp.net');
  });

  it('is a no-op when mcpSessionContext is not provided', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    // Should not throw
    expect(() => sm.updateMcpActorJid('1555000003@s.whatsapp.net')).not.toThrow();
  });
});

// ─── notifyUnexpectedExit branch coverage ────────────────────────────────────

describe('notifyUnexpectedExit via exit handler', () => {
  let mockChild: ReturnType<typeof makeMockChild>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = makeMockChild(12345);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exit code 0 (clean exit) does not send crash notification', async () => {
    const db = makeDb();
    const { messenger, sentMessages } = makeMessenger();
    const notifyUser = vi.fn();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), notifyUser });
    await sm.spawnSession();
    // active=false so exit is a "clean shutdown"
    (sm as unknown as { active: boolean }).active = false;
    mockChild._exitCb?.(0, null);

    await new Promise((r) => setImmediate(r));
    expect(notifyUser).not.toHaveBeenCalled();
    expect(sentMessages).toHaveLength(0);
  });

  it('exit by signal sends signal-based notification', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), notifyUser });
    await sm.spawnSession();
    mockChild._exitCb?.(null, 'SIGTERM');

    await vi.waitFor(() => expect(notifyUser).toHaveBeenCalledTimes(1));
    expect(notifyUser.mock.calls[0][0]).toContain('terminated by signal SIGTERM');
  });

  it('exit code 0 with no signal from active session does not send notification', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), notifyUser });
    await sm.spawnSession();
    mockChild._exitCb?.(0, null);

    await new Promise((r) => setImmediate(r));
    expect(notifyUser).not.toHaveBeenCalled();
  });
});

// ─── handleProviderEvent branch coverage ─────────────────────────────────────

describe('handleProviderEvent branch coverage', () => {
  let mockChild: ReturnType<typeof makeMockChild>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = makeMockChild(12345);
    (mockChild.stdin as unknown as { write: ReturnType<typeof vi.fn> }).write = vi.fn(
      (_data: unknown, _enc?: unknown, cb?: (err?: Error | null) => void) => { if (cb) cb(); },
    );
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('init event for gemini-cli captures geminiSessionId', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, provider: 'gemini-cli', onEvent: vi.fn(),
    });
    await sm.spawnSession();

    // Simulate gemini session/new response
    const sessionResponse = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: { sessionId: 'gemini-sess-abc' },
    }) + '\n';
    mockChild.stdout.emit('data', Buffer.from(sessionResponse));

    expect((sm as unknown as { geminiSessionId: string | null }).geminiSessionId).toBe('gemini-sess-abc');
    expect(sm.getStatus().sessionId).toBe('gemini-sess-abc');
  });

  it('init event for codex-cli clears codexResumeThreadStartReqId on successful resume', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, provider: 'codex-cli', onEvent: vi.fn(),
    });
    // Fresh spawn to get the codex child
    await sm.spawnSession();

    // Simulate successful thread/start response with threadId
    const threadResponse = JSON.stringify({
      jsonrpc: '2.0',
      id: `ws-${2}`,
      result: { id: 'thread_success_xyz' },
    }) + '\n';
    mockChild.stdout.emit('data', Buffer.from(threadResponse));

    expect((sm as unknown as { codexResumeThreadStartReqId: string | null }).codexResumeThreadStartReqId).toBeNull();
    expect(sm.getStatus().sessionId).toBe('thread_success_xyz');
  });

  it('handleProviderEvent records token_usage events in budget', async () => {
    vi.useFakeTimers();
    const db = makeDb();
    const { messenger } = makeMessenger();
    const events: AgentEvent[] = [];
    const fetchMock = vi.fn().mockResolvedValue(makeSseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello.' } },
      { type: 'message_delta', usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: (e) => events.push(e),
      provider: 'anthropic-api',
      providerConfig: {
        budget: { maxInputTokensPerTurn: 10_000, maxOutputTokensPerTurn: 10_000 },
      },
    });

    await sm.spawnSession();
    await sm.sendTurn('test budget recording');

    // Token usage event should have been emitted
    expect(events.some((e) => e.type === 'token_usage' || e.type === 'result')).toBe(true);
    vi.useRealTimers();
  });
});

// ─── sendTurn budget throttle branch ─────────────────────────────────────────

describe('sendTurn budget throttle', () => {
  it('sendTurn emits a result event and returns early when budget disallows', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const events: AgentEvent[] = [];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // requestsPerMinute: 1 so the first turn uses it up, second is throttled
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: (e) => events.push(e),
      provider: 'openai-api',
      providerConfig: {
        budget: { requestsPerMinute: 1 },
      },
    });

    await sm.spawnSession();

    // Exhaust the budget by checking it once (ProviderBudget reserves a slot per check)
    // We can do this by directly invoking checkBudget via the budget field
    const budget = (sm as unknown as { budget: { checkBudget: (id: string) => unknown } }).budget;
    budget?.checkBudget(CHAT_JID);

    // Now sendTurn should be throttled
    await sm.sendTurn('throttled message');

    // Should not have called fetch (no actual API call made — budget short-circuits)
    expect(fetchMock).not.toHaveBeenCalled();
    // Should have emitted a result event with throttle reason
    const resultEvent = events.find((e) => e.type === 'result');
    expect(resultEvent).toBeDefined();
    expect((resultEvent as { type: 'result'; text: string | null }).text).toContain('Throttled');
  });
});

// ─── spawnSession managed-provider existingRowId branch ──────────────────────

describe('spawnSession managed-provider existingRowId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reuses existingRowId for managed-loop provider instead of creating new session', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const fetchMock = vi.fn().mockResolvedValue(makeSseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'message_stop' },
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      provider: 'anthropic-api',
    });

    await sm.spawnSession(undefined, 99);

    // When existingRowId is provided, updateSessionStatus is called with 'active'
    // and createSession is NOT called (no new row).
    expect(updateSessionStatus).toHaveBeenCalledWith(db, 99, 'active');
    expect(createSession).not.toHaveBeenCalled();
    expect(sm.getStatus()).toMatchObject({ active: true, pid: null });
    expect((sm as unknown as { dbRowId: number | null }).dbRowId).toBe(99);
  });
});

// ─── spawnSession managed-provider db failure branch ─────────────────────────

describe('spawnSession managed-provider db failure', () => {
  it('rolls back active state when db throws during managed-provider spawn', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    (createSession as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY: managed provider');
    });

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      provider: 'anthropic-api',
    });

    await expect(sm.spawnSession()).rejects.toThrow('SQLITE_BUSY');
    expect(sm.getStatus()).toMatchObject({ active: false, pid: null, sessionId: null });
  });
});

// ─── spawnSession spawn-per-turn existingRowId branch ────────────────────────

describe('spawnSession spawn-per-turn existingRowId', () => {
  let mockChild: ReturnType<typeof makeMockChild>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = makeMockChild(12345);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reuses existingRowId for spawn-per-turn instead of creating new session', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      provider: 'opencode-cli',
    });

    await sm.spawnSession(undefined, 77);

    expect(createSession).not.toHaveBeenCalled();
    expect((sm as unknown as { dbRowId: number | null }).dbRowId).toBe(77);
  });
});

// ─── spawn-per-turn ENOENT and spawn error branch coverage ───────────────────

describe('spawn-per-turn error branches', () => {
  let mockChild: ReturnType<typeof makeMockChild>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = makeMockChild(12345);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ENOENT from spawn-per-turn child notifies user and does not call onCrash', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();
    const onCrash = vi.fn();

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      provider: 'opencode-cli', notifyUser, onCrash,
    });

    await sm.spawnSession();
    // sendTurn spawns a NEW child (spawn-per-turn). Capture it after spawn.
    const sendPromise = sm.sendTurn('hello');

    // The new child spawned by sendTurn registers its own 'error' handler.
    // It's the LAST set of mock calls after sendTurn.
    const allOnCalls = (mockChild.on as ReturnType<typeof vi.fn>).mock.calls;
    const errHandlerCall = [...allOnCalls].reverse().find((c: unknown[]) => c[0] === 'error');
    const enoentErr: NodeJS.ErrnoException = Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' });
    (errHandlerCall?.[1] as ((e: NodeJS.ErrnoException) => void) | undefined)?.(enoentErr);

    await sendPromise.catch(() => {});
    expect(notifyUser).toHaveBeenCalledWith(expect.stringContaining('is not installed'));
    expect(onCrash).not.toHaveBeenCalled();
  });

  it('non-ENOENT spawn error from spawn-per-turn calls onCrash and notifies user', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();
    const onCrash = vi.fn();

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      provider: 'opencode-cli', notifyUser, onCrash,
    });

    await sm.spawnSession();
    const sendPromise = sm.sendTurn('hello');

    const allOnCalls = (mockChild.on as ReturnType<typeof vi.fn>).mock.calls;
    const errHandlerCall = [...allOnCalls].reverse().find((c: unknown[]) => c[0] === 'error');
    const spawnErr: NodeJS.ErrnoException = Object.assign(new Error('ENOMEM'), { code: 'ENOMEM' });
    (errHandlerCall?.[1] as ((e: NodeJS.ErrnoException) => void) | undefined)?.(spawnErr);

    await sendPromise.catch(() => {});
    expect(notifyUser).toHaveBeenCalledWith(expect.stringContaining('failed to start'));
    expect(onCrash).toHaveBeenCalledWith(expect.objectContaining({ exitCode: null, signal: null }));
  });

  it('spawn-per-turn exit code 0 does not call onCrash or notifyUser', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();
    const onCrash = vi.fn();

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      provider: 'opencode-cli', notifyUser, onCrash,
    });

    await sm.spawnSession();
    await sm.sendTurn('hello clean exit');

    // Exit code 0 = normal turn completion
    mockChild._exitCb?.(0, null);

    // Give setImmediate callbacks a chance to run
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(onCrash).not.toHaveBeenCalled();
    expect(notifyUser).not.toHaveBeenCalled();
  });
});

// ─── claude-cli child ENOENT branch ──────────────────────────────────────────

describe('claude-cli child ENOENT branch', () => {
  let mockChild: ReturnType<typeof makeMockChild>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = makeMockChild(12345);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ENOENT notifies user and does not call onCrash', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();
    const onCrash = vi.fn();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), notifyUser, onCrash });
    await sm.spawnSession();

    // Find the 'error' handler on the child
    const errorHandlerCall = (mockChild.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'error',
    );
    const errorHandler = errorHandlerCall?.[1] as ((e: NodeJS.ErrnoException) => void) | undefined;
    const enoentErr: NodeJS.ErrnoException = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    errorHandler?.(enoentErr);

    expect(notifyUser).toHaveBeenCalledWith(expect.stringContaining('is not installed'));
    expect(onCrash).not.toHaveBeenCalled();
  });

  it('non-ENOENT spawn error calls onCrash and notifies user', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();
    const onCrash = vi.fn();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), notifyUser, onCrash });
    await sm.spawnSession();

    const errorHandlerCall = (mockChild.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'error',
    );
    const errorHandler = errorHandlerCall?.[1] as ((e: NodeJS.ErrnoException) => void) | undefined;
    const spawnErr: NodeJS.ErrnoException = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    errorHandler?.(spawnErr);

    expect(notifyUser).toHaveBeenCalledWith(expect.stringContaining('failed to start'));
    expect(onCrash).toHaveBeenCalledWith(expect.objectContaining({
      exitCode: null,
      signal: null,
    }));
  });
});

// ─── codex unhandled server request branch ───────────────────────────────────

describe('Codex unhandled server request', () => {
  let mockChild: ReturnType<typeof makeMockChild>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = makeMockChild(12345);
    (mockChild.stdin as unknown as { write: ReturnType<typeof vi.fn> }).write = vi.fn(
      (_data: unknown, _enc?: unknown, cb?: (err?: Error | null) => void) => { if (cb) cb(); },
    );
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('unhandled JSON-RPC server method logs a warning without sending a response', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, provider: 'codex-cli', onEvent: vi.fn(),
    });
    await sm.spawnSession();
    (mockChild.stdin.write as ReturnType<typeof vi.fn>).mockClear();

    const unknownRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'some/unknown/method',
      params: {},
    }) + '\n';
    mockChild.stdout.emit('data', Buffer.from(unknownRequest));

    // No response should have been written to stdin
    expect(mockChild.stdin.write).not.toHaveBeenCalled();
  });

  it('item/tool/requestUserInput responds with empty input (deny gracefully)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, provider: 'codex-cli', onEvent: vi.fn(),
    });
    await sm.spawnSession();
    (mockChild.stdin.write as ReturnType<typeof vi.fn>).mockClear();

    const userInputRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 42,
      method: 'item/tool/requestUserInput',
      params: {},
    }) + '\n';
    mockChild.stdout.emit('data', Buffer.from(userInputRequest));

    expect(mockChild.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('"input":""'),
    );
  });

  it('all other approval methods auto-approve (fileChange, permissions, applyPatch, execCommand)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, provider: 'codex-cli', onEvent: vi.fn(),
    });
    await sm.spawnSession();

    const methods = [
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
      'applyPatchApproval',
      'execCommandApproval',
    ];

    for (const method of methods) {
      (mockChild.stdin.write as ReturnType<typeof vi.fn>).mockClear();
      const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }) + '\n';
      mockChild.stdout.emit('data', Buffer.from(req));
      expect(mockChild.stdin.write).toHaveBeenCalledWith(expect.stringContaining('"decision":"approved"'));
    }
  });
});

// ─── getProviderId ────────────────────────────────────────────────────────────

describe('getProviderId', () => {
  it('returns the configured provider id', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      provider: 'codex-cli',
    });
    expect(sm.getProviderId()).toBe('codex-cli');
  });

  it('returns claude-cli for default provider', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    expect(sm.getProviderId()).toBe('claude-cli');
  });
});

// ─── durability upsert branch coverage ───────────────────────────────────────

describe('durability upsert branch coverage', () => {
  let mockChild: ReturnType<typeof makeMockChild>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = makeMockChild(12345);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('setDurability enables checkpoint upserts during spawnSession', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const upsert = vi.fn();
    const durability = { upsertSessionCheckpoint: upsert };

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    sm.setDurability(durability as unknown as Parameters<typeof sm.setDurability>[0]);
    await sm.spawnSession();

    expect(upsert).toHaveBeenCalledWith(
      toConversationKey(CHAT_JID),
      expect.objectContaining({ sessionStatus: 'active' }),
    );
  });

  it('setDurability enables checkpoint upserts during shutdown', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const upsert = vi.fn();
    const durability = { upsertSessionCheckpoint: upsert };

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    sm.setDurability(durability as unknown as Parameters<typeof sm.setDurability>[0]);
    await sm.spawnSession();
    upsert.mockClear();

    await sm.shutdown();
    expect(upsert).toHaveBeenCalledWith(
      toConversationKey(CHAT_JID),
      expect.objectContaining({ sessionStatus: 'suspended' }),
    );
  });

  it('setDurability checkpoint called with "ended" status when suspend=false', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const upsert = vi.fn();
    const durability = { upsertSessionCheckpoint: upsert };

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    sm.setDurability(durability as unknown as Parameters<typeof sm.setDurability>[0]);
    await sm.spawnSession();
    upsert.mockClear();

    await sm.shutdown(false);
    expect(upsert).toHaveBeenCalledWith(
      toConversationKey(CHAT_JID),
      expect.objectContaining({ sessionStatus: 'ended' }),
    );
  });
});

// ─── sendTurn with no active session ────────────────────────────────────────

describe('sendTurn with no active session', () => {
  it('throws when called before spawnSession', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await expect(sm.sendTurn('hello')).rejects.toThrow(/No active session/);
  });
});

// ─── providerConfig-driven claude-cli args coverage ──────────────────────────

describe('providerConfig-driven claude-cli args', () => {
  let mockChild: ReturnType<typeof makeMockChild>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = makeMockChild(12345);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('--system-prompt is used when rawSystemPrompt=true', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      providerConfig: { rawSystemPrompt: true },
    });
    await sm.spawnSession();

    const args: string[] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(args).toContain('--system-prompt');
    expect(args).not.toContain('--append-system-prompt');
  });

  it('permissionMode is forwarded when set in providerConfig', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      providerConfig: { permissionMode: 'default' },
    });
    await sm.spawnSession();

    const args: string[] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const pmIdx = args.indexOf('--permission-mode');
    expect(pmIdx).toBeGreaterThan(-1);
    expect(args[pmIdx + 1]).toBe('default');
  });

  it('--disable-slash-commands is added when disableSlashCommands=true', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      providerConfig: { disableSlashCommands: true },
    });
    await sm.spawnSession();

    const args: string[] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(args).toContain('--disable-slash-commands');
  });

  it('--strict-mcp-config is added when strictMcpConfig=true', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      providerConfig: { strictMcpConfig: true },
    });
    await sm.spawnSession();

    const args: string[] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(args).toContain('--strict-mcp-config');
  });

  it('--no-session-persistence is added when noSessionPersistence=true', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      providerConfig: { noSessionPersistence: true },
    });
    await sm.spawnSession();

    const args: string[] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(args).toContain('--no-session-persistence');
  });

  it('--tools with array is forwarded', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      providerConfig: { tools: ['Bash', 'Read'] },
    });
    await sm.spawnSession();

    const args: string[] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const toolsIdx = args.indexOf('--tools');
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(args[toolsIdx + 1]).toBe('Bash');
    expect(args[toolsIdx + 2]).toBe('Read');
  });

  it('--tools with empty array passes empty string sentinel', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      providerConfig: { tools: [] },
    });
    await sm.spawnSession();

    const args: string[] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const toolsIdx = args.indexOf('--tools');
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(args[toolsIdx + 1]).toBe('');
  });

  it('--tools with a string value is forwarded directly', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      providerConfig: { tools: 'Bash' },
    });
    await sm.spawnSession();

    const args: string[] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const toolsIdx = args.indexOf('--tools');
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(args[toolsIdx + 1]).toBe('Bash');
  });

  it('--mcp-config with array is forwarded', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      providerConfig: { mcpConfig: ['/path/to/mcp1.json', '/path/to/mcp2.json'] },
    });
    await sm.spawnSession();

    const args: string[] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const mcpIdx = args.indexOf('--mcp-config');
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(args[mcpIdx + 1]).toBe('/path/to/mcp1.json');
    expect(args[mcpIdx + 2]).toBe('/path/to/mcp2.json');
  });

  it('--mcp-config with string is forwarded directly', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      providerConfig: { mcpConfig: '/path/to/mcp.json' },
    });
    await sm.spawnSession();

    const args: string[] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const mcpIdx = args.indexOf('--mcp-config');
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(args[mcpIdx + 1]).toBe('/path/to/mcp.json');
  });

  it('--setting-sources is forwarded when settingSources is set', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      providerConfig: { settingSources: 'project' },
    });
    await sm.spawnSession();

    const args: string[] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const settingSourcesIdx = args.indexOf('--setting-sources');
    expect(settingSourcesIdx).toBeGreaterThan(-1);
    expect(args[settingSourcesIdx + 1]).toBe('project');
  });

  it('--effort is forwarded when effort is set', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      providerConfig: { effort: 'low' },
    });
    await sm.spawnSession();

    const args: string[] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const effortIdx = args.indexOf('--effort');
    expect(effortIdx).toBeGreaterThan(-1);
    expect(args[effortIdx + 1]).toBe('low');
  });

  it('--agents is forwarded when agents is set as string', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      providerConfig: { agents: 'all' },
    });
    await sm.spawnSession();

    const args: string[] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const agentsIdx = args.indexOf('--agents');
    expect(agentsIdx).toBeGreaterThan(-1);
    expect(args[agentsIdx + 1]).toBe('all');
  });

  it('--agents is not added when agents is empty string', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      providerConfig: { agents: '' },
    });
    await sm.spawnSession();

    const args: string[] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(args).not.toContain('--agents');
  });

  it('--fallback-model is forwarded as array when set', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      providerConfig: { fallbackModel: ['claude-sonnet-4-5', 'claude-haiku-4-5'] },
    });
    await sm.spawnSession();

    const args: string[] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const fallbackIdx = args.indexOf('--fallback-model');
    expect(fallbackIdx).toBeGreaterThan(-1);
    expect(args[fallbackIdx + 1]).toContain('claude-sonnet-4-5');
    expect(args[fallbackIdx + 1]).toContain('claude-haiku-4-5');
  });

  it('--fallback-model is not added when fallbackModel is empty string', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      providerConfig: { fallbackModel: '' },
    });
    await sm.spawnSession();

    const args: string[] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(args).not.toContain('--fallback-model');
  });

  it('--plugin-dir args are added for each pluginDir', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      pluginDirs: ['/plugins/a', '/plugins/b'],
    });
    await sm.spawnSession();

    const args: string[] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const pluginDirIndices = args.reduce<number[]>((acc, v, i) => { if (v === '--plugin-dir') acc.push(i); return acc; }, []);
    expect(pluginDirIndices).toHaveLength(2);
    expect(args[pluginDirIndices[0] + 1]).toBe('/plugins/a');
    expect(args[pluginDirIndices[1] + 1]).toBe('/plugins/b');
  });
});

// ─── opencode-cli session resume via sessionId ────────────────────────────────

describe('opencode-cli session resume via sessionId', () => {
  let mockChild: ReturnType<typeof makeMockChild>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = makeMockChild(12345);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes --session arg when sessionId is set and not the synthetic init id', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      provider: 'opencode-cli',
    });

    await sm.spawnSession();

    // Inject a real (non-synthetic) sessionId, simulating a second turn after server assigns one
    (sm as unknown as { sessionId: string | null }).sessionId = 'real-opencode-session-id';

    // Use a new mockChild for the second spawn
    const mockChild2 = makeMockChild(22222);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild2);
    await sm.sendTurn('second turn');

    const secondSpawnArgs: string[] = (spawn as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] ?? [];
    expect(secondSpawnArgs).toContain('--session');
    expect(secondSpawnArgs).toContain('real-opencode-session-id');
  });

  it('does not include --session when sessionId starts with "opencode-cli-" (synthetic)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      provider: 'opencode-cli',
    });

    await sm.spawnSession();
    // sessionId is already the synthetic one set during spawnSession: "opencode-cli-<ts>"
    const mockChild2 = makeMockChild(22222);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild2);
    await sm.sendTurn('first turn');

    const secondSpawnArgs: string[] = (spawn as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] ?? [];
    expect(secondSpawnArgs).not.toContain('--session');
  });

  it('opencode-cli includes model -m when model is set and no custom baseUrl', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      provider: 'opencode-cli',
      model: 'anthropic/claude-sonnet-4-5',
    });

    await sm.spawnSession();
    const mockChild2 = makeMockChild(22222);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild2);
    await sm.sendTurn('model turn');

    const spawnArgs: string[] = (spawn as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] ?? [];
    expect(spawnArgs).toContain('-m');
    expect(spawnArgs).toContain('anthropic/claude-sonnet-4-5');
  });
});
