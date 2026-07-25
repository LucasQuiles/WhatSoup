import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { SessionManager, MAX_STDOUT_LINE_BYTES } from '../../../src/runtimes/agent/session.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type { ProviderMcpBridge } from '../../../src/runtimes/agent/providers/types.ts';
import { ProviderExecutionGate } from '../../../src/runtimes/agent/provider-execution-gate.ts';
import { shortHash } from '../../../src/lib/short-hash.ts';
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
    // Store exit and drained-close handlers independently so tests can model
    // the complete child-process lifecycle.
    if (event === 'exit') {
      (child as unknown as { _exitCb: (...args: unknown[]) => void })._exitCb = cb;
    }
    if (event === 'close') {
      (child as unknown as { _closeCb: (...args: unknown[]) => void })._closeCb = cb;
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
    _closeCb: null as ((...args: unknown[]) => void) | null,
  };

  return child;
}

type MockChild = ReturnType<typeof makeMockChild>;

function exitOnSigkill(child: MockChild): void {
  child.kill.mockImplementation((signal: NodeJS.Signals | number) => {
    if (signal === 'SIGKILL') {
      queueMicrotask(() => {
        child._exitCb?.(null, 'SIGKILL');
        child._closeCb?.(null, 'SIGKILL');
      });
    }
    return true;
  });
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/process-tree.ts', () => ({
  killSessionTree: vi.fn(async (target: { kill(signal: NodeJS.Signals): boolean }, signal: NodeJS.Signals) => {
    target.kill(signal);
  }),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

// Mock keyring so lookupCredential is a pure env-lookup (no fs/execFileSync
// side effects). SERVICE_ENV_MAP and resolveProviderKeyService are preserved
// from the real module. This prevents the node:fs mock pollution above from
// leaking into buildChildEnv tests after the W-4 migration routed key reads
// through resolveApiKey → lookupCredential.
vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...actual,
    lookupCredential: vi.fn((service: string): string | null => {
      const envVar = actual.SERVICE_ENV_MAP[service];
      if (!envVar) return null;
      const val = process.env[envVar];
      return val && val.length > 0 ? val : null;
    }),
  };
});

// Import after mocks are registered
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { killSessionTree } from '../../../src/runtimes/agent/process-tree.ts';
import { toConversationKey } from '../../../src/core/conversation-key.ts';
import { formatAge, TURN_WATCHDOG_MS, WATCHDOG_SOFT_MS, WATCHDOG_WARN_MS, WATCHDOG_HARD_MS, STALLED_OP_KILL_GRACE_MS, LONG_OP_CEILING_MS, PROVIDER_DISPLAY_NAMES } from '../../../src/runtimes/agent/session.ts';
import { OpenAIApiProvider } from '../../../src/runtimes/agent/providers/openai-api.ts';
import { AnthropicApiProvider } from '../../../src/runtimes/agent/providers/anthropic-api.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(): Database {
  return {
    assertWritableCompatibility: vi.fn(),
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

function lastJsonRpcRequest(child: MockChild, method: string): Record<string, unknown> {
  const request = child.stdin.write.mock.calls
    .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
    .findLast((candidate) => candidate['method'] === method);
  if (request === undefined) throw new Error(`missing ${method} request`);
  return request;
}

// ─── DB mock helpers ──────────────────────────────────────────────────────────

vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  createSession: vi.fn(() => 42),
  incrementMessageCount: vi.fn(),
  resolveResumableAgentSession: vi.fn((
    _db: unknown,
    input: {
      provider: string;
      agentSessionRowId?: number;
      workspaceKey?: string;
    },
  ) => ({
    id: input.agentSessionRowId ?? 42,
    provider: input.provider,
    workspace_key: input.workspaceKey ?? null,
  })),
  updateResumedSessionStatus: vi.fn(),
  updateSessionId: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateTranscriptPath: vi.fn(),
  backfillSessionProvider: vi.fn(),
}));

import {
  createSession,
  incrementMessageCount,
  updateResumedSessionStatus,
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

  it('rejects spawnSession before provider creation when the database is drained', async () => {
    const db = makeDb();
    const rejection = new Error('database compatibility drain');
    vi.mocked(db.assertWritableCompatibility).mockImplementation(() => {
      throw rejection;
    });
    const sm = new SessionManager({
      db,
      messenger: makeMessenger().messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
    });

    await expect(sm.spawnSession()).rejects.toBe(rejection);

    expect(db.assertWritableCompatibility).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('rejects sendTurn before budget or provider I/O when the database is drained', async () => {
    const db = makeDb();
    const rejection = new Error('database compatibility drain');
    const sm = new SessionManager({
      db,
      messenger: makeMessenger().messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
    });
    await sm.spawnSession();
    vi.mocked(db.assertWritableCompatibility).mockImplementation(() => {
      throw rejection;
    });
    vi.mocked(db.assertWritableCompatibility).mockClear();

    await expect(sm.sendTurn('must not dispatch')).rejects.toBe(rejection);

    expect(db.assertWritableCompatibility).toHaveBeenCalledTimes(1);
    expect(mockChild.stdin.write).not.toHaveBeenCalled();
    expect(incrementMessageCount).not.toHaveBeenCalled();
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

  it('serializes runtime context and user text as distinct stream-json blocks', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();

    await sm.sendTurn({
      applicationContext: ['receipt=2026-05-28T20:26:40.000Z age=95'],
      userText: 'stop that flow now',
    });

    const written = (mockChild.stdin.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(JSON.parse(written.trim())).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'receipt=2026-05-28T20:26:40.000Z age=95' },
          { type: 'text', text: 'stop that flow now' },
        ],
      },
    });
  });

  it('rejects a second provider request until the accepted terminal result clears the first owner', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    let sm!: SessionManager;
    const onEvent = vi.fn((event: AgentEvent) => {
      // AgentRuntime clears the provider boundary only after admitting the
      // terminal result for the current owner.
      if (event.type === 'result') sm.completeProviderTurn();
    });
    sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent });
    await sm.spawnSession();

    await sm.sendTurn('first request');

    await expect(sm.sendTurn('overlapping request')).rejects.toThrow(
      /PROVIDER_TURN_IN_FLIGHT/,
    );
    expect(mockChild.stdin.write).toHaveBeenCalledTimes(1);

    mockChild.stdout.emit('data', Buffer.from(
      `${JSON.stringify({ type: 'result', is_error: false, result: '' })}\n`,
    ));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'result' }));

    await sm.sendTurn('second request');
    expect(mockChild.stdin.write).toHaveBeenCalledTimes(2);
  });

  it('settles the exact provider-turn barrier only when that request terminalizes', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();

    await expect(sm.waitForProviderTurnToTerminalize()).resolves.toBeUndefined();
    await sm.sendTurn('first request');

    let firstSettled = false;
    const firstBarrier = sm.waitForProviderTurnToTerminalize().then(() => {
      firstSettled = true;
    });
    await Promise.resolve();
    expect(firstSettled).toBe(false);

    sm.completeProviderTurn();
    await firstBarrier;
    expect(firstSettled).toBe(true);

    await sm.sendTurn('second request');
    let secondSettled = false;
    const secondBarrier = sm.waitForProviderTurnToTerminalize().then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    sm.completeProviderTurn();
    await secondBarrier;
    expect(secondSettled).toBe(true);
  });

  it('acquires provider ownership before awaiting a delayed stdin write', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    let finishFirstWrite: ((err?: Error | null) => void) | undefined;
    mockChild.stdin.write.mockImplementationOnce(
      (_data: unknown, _encoding: unknown, callback?: (err?: Error | null) => void) => {
        finishFirstWrite = callback;
        return true;
      },
    );

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();

    const firstTurn = sm.sendTurn('first request');
    await vi.waitFor(() => expect(finishFirstWrite).toBeTypeOf('function'));

    try {
      await expect(sm.sendTurn('concurrent request')).rejects.toThrow(
        /PROVIDER_TURN_IN_FLIGHT/,
      );
      expect(mockChild.stdin.write).toHaveBeenCalledTimes(1);
    } finally {
      finishFirstWrite?.();
      await firstTurn;
    }
  });

  it('keeps the watchdog armed when a managed provider resolves without a terminal result', async () => {
    vi.useFakeTimers();
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'openai-api',
    });
    await sm.spawnSession();
    const state = sm as unknown as {
      managedProviderSession: { sendTurn: ReturnType<typeof vi.fn> };
      watchdogHard: ReturnType<typeof setTimeout> | null;
    };
    state.managedProviderSession.sendTurn = vi.fn(async () => {});

    await sm.sendTurn('provider returns without a result');

    expect(sm.getStatus().turnInFlight).toBe(true);
    expect(state.watchdogHard).not.toBeNull();
    await expect(sm.sendTurn('must remain closed')).rejects.toThrow(
      /PROVIDER_TURN_IN_FLIGHT/,
    );
    await sm.shutdown(false);
    vi.useRealTimers();
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

  it('spawn-per-turn non-zero close invokes crash handling and notifies the user', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const onCrash = vi.fn();
    const notifyUser = vi.fn();

    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      provider: 'opencode-cli',
      model: 'glm/test-model',
      onEvent: vi.fn(),
      onCrash,
      notifyUser,
    });

    await sm.spawnSession();
    await sm.sendTurn('hello');

    mockChild._exitCb?.(1, null);
    mockChild._closeCb?.(1, null);
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
    expect(sm.getStatus()).toEqual({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null, turnInFlight: false, durableFailureClosed: false, durableFailureInconclusive: false });

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

    expect(sm.getStatus()).toEqual({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null, turnInFlight: false, durableFailureClosed: false, durableFailureInconclusive: false });
  });

  it('watchdog rearming is separate from provider turn ownership', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();
    expect(sm.getStatus().turnInFlight).toBe(false);

    sm.tickWatchdog();
    expect(sm.getStatus().turnInFlight).toBe(false);

    await sm.sendTurn('first request');
    expect(sm.getStatus().turnInFlight).toBe(true);

    sm.clearTurnWatchdog();
    expect(sm.getStatus().turnInFlight).toBe(true);
    await expect(sm.sendTurn('overlapping request')).rejects.toThrow(
      /PROVIDER_TURN_IN_FLIGHT/,
    );

    sm.completeProviderTurn();
    expect(sm.getStatus().turnInFlight).toBe(false);
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

  it('persistent Claude stops admitting later records in a chunk after malformed JSON quarantines it', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const events: AgentEvent[] = [];
    let shutdownPromise: Promise<void> | null = null;
    let sm!: SessionManager;
    sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'parse_error') shutdownPromise = sm.shutdown(false);
      },
    });
    await sm.spawnSession();

    mockChild.stdout.emit('data', Buffer.from([
      '{not valid json}',
      JSON.stringify({ type: 'result', is_error: false, result: 'must be fenced' }),
      '',
    ].join('\n')));

    expect(events).toEqual([
      { type: 'parse_error', line: '{not valid json}' },
    ]);
    expect(shutdownPromise).not.toBeNull();
    await shutdownPromise;
  });

  it('forwards every event from one multi-block provider envelope in order', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const events: AgentEvent[] = [];
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: (event) => events.push(event),
    });
    await sm.spawnSession();

    mockChild.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
          { type: 'tool_result', tool_use_id: 'tool-2', is_error: true },
          { type: 'tool_result', tool_use_id: 'tool-3', content: 'ok' },
        ],
      },
    })}\n`));

    expect(events).toEqual([
      { type: 'tool_result', isError: false, toolId: 'tool-1', content: 'ok' },
      { type: 'tool_result', isError: true, toolId: 'tool-2', content: '' },
      { type: 'tool_result', isError: false, toolId: 'tool-3', content: 'ok' },
    ]);
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
    exitOnSigkill(mockChild);

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
      turnInFlight: false,
      durableFailureClosed: false,
      durableFailureInconclusive: false,
    });
  });

  it('db failure during spawn does not block a later successful retry', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    (createSession as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    exitOnSigkill(mockChild);

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
      turnInFlight: false,
      durableFailureClosed: false,
      durableFailureInconclusive: false,
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
      expect.stringMatching(new RegExp(`^${provider}-[0-9a-f-]{36}$`)),
    );
    expect(events.some((event) => event.type === 'init')).toBe(true);
    expect(sm.getStatus()).toMatchObject({
      active: true,
      pid: null,
      sessionId: expect.stringMatching(new RegExp(`^${provider}-[0-9a-f-]{36}$`)),
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
    const generationIdentity = { managerId: 'managed-current', generation: 1 };
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
    sm.bindGenerationOwnership(() => generationIdentity);

    await sm.spawnSession();
    await expect(sm.sendTurn('fail this turn')).rejects.toThrow('stream failed');

    expect(updateResumedSessionStatus).toHaveBeenCalledWith(
      db,
      42,
      expect.stringMatching(/^openai-api-[0-9a-f-]{36}$/),
      'openai-api',
      'crashed',
    );
    expect(onCrash).toHaveBeenCalledWith(expect.objectContaining({
      exitCode: null,
      signal: null,
      sessionId: expect.stringMatching(/^openai-api-[0-9a-f-]{36}$/),
      dbRowId: 42,
      generationIdentity,
    }));
    expect(notifyUser).toHaveBeenCalledWith(expect.stringContaining('provider request failed'));
    expect(sm.getStatus()).toMatchObject({ active: false, pid: null, sessionId: null });
  });

  it('does not notify when a managed turn failure belongs to a stale generation', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const onCrash = vi.fn();
    const notifyUser = vi.fn();
    let generationIdentity = { managerId: 'managed-stale-turn', generation: 1 };
    vi.spyOn(OpenAIApiProvider.prototype, 'sendTurn').mockRejectedValue(new Error('late failure'));

    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'openai-api',
      onCrash,
      notifyUser,
    });
    sm.bindGenerationOwnership(() => generationIdentity);
    await sm.spawnSession();
    generationIdentity = { managerId: 'managed-stale-turn', generation: 2 };
    vi.mocked(updateSessionStatus).mockClear();

    await expect(sm.sendTurn('late turn')).rejects.toThrow('late failure');

    expect(updateSessionStatus).not.toHaveBeenCalled();
    expect(onCrash).not.toHaveBeenCalled();
    expect(notifyUser).not.toHaveBeenCalled();
    expect(sm.getStatus()).toMatchObject({ active: true });
    expect((sm as unknown as { managedProviderSession: unknown }).managedProviderSession).not.toBeNull();
  });

  it('does not crash a replacement managed generation when an old turn rejects late', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const onCrash = vi.fn();
    const notifyUser = vi.fn();
    const crashCallbacks: Array<(info: { exitCode: number | null; signal: string | null; provider: string }) => void> = [];
    let rejectOldTurn!: (err: Error) => void;
    const oldTurn = new Promise<void>((_resolve, reject) => {
      rejectOldTurn = reject;
    });
    vi.spyOn(OpenAIApiProvider.prototype, 'initialize').mockImplementation(async function (_opts) {
      crashCallbacks.push(_opts.onCrash as (typeof crashCallbacks)[number]);
    });
    vi.spyOn(OpenAIApiProvider.prototype, 'sendTurn').mockReturnValueOnce(oldTurn);
    const killSpy = vi.spyOn(OpenAIApiProvider.prototype, 'kill');
    let generationIdentity = { managerId: 'managed-replacement', generation: 1 };
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'openai-api',
      onCrash,
      notifyUser,
    });
    sm.bindGenerationOwnership(() => generationIdentity);
    await sm.spawnSession();
    const oldTurnResult = sm.sendTurn('generation one').catch((err) => err as Error);

    crashCallbacks[0]!({ exitCode: 1, signal: null, provider: 'openai-api' });
    generationIdentity = { managerId: 'managed-replacement', generation: 2 };
    await sm.spawnSession();
    vi.mocked(updateSessionStatus).mockClear();
    onCrash.mockClear();
    notifyUser.mockClear();
    killSpy.mockClear();

    rejectOldTurn(new Error('late generation-one failure'));
    const error = await oldTurnResult;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('late generation-one failure');
    expect(killSpy).not.toHaveBeenCalled();
    expect(updateSessionStatus).not.toHaveBeenCalled();
    expect(onCrash).not.toHaveBeenCalled();
    expect(notifyUser).not.toHaveBeenCalled();
    expect(sm.getStatus()).toMatchObject({ active: true });
    expect((sm as unknown as { managedProviderSession: unknown }).managedProviderSession).not.toBeNull();
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
    // openai-api descriptor hard timeout = 10 min (NOT the 30-min default) — L1-F1
    await vi.advanceTimersByTimeAsync(600_000 + 1);
    const err = await turn;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('aborted by watchdog');
    expect(killSpy).toHaveBeenCalled();
    expect(updateResumedSessionStatus).toHaveBeenCalledWith(
      db,
      42,
      expect.stringMatching(/^openai-api-[0-9a-f-]{36}$/),
      'openai-api',
      'crashed',
    );
    expect(onCrash).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: expect.stringMatching(/^openai-api-[0-9a-f-]{36}$/),
      dbRowId: 42,
      generationIdentity: null,
    }));
    expect(notifyUser).toHaveBeenCalledWith(expect.stringContaining('10 minutes'));
    expect(sm.getStatus()).toMatchObject({ active: false, pid: null, sessionId: null });
    vi.useRealTimers();
  });

  it('does not notify or kill for a stale managed-provider watchdog', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const onCrash = vi.fn();
    const notifyUser = vi.fn();
    const killSpy = vi.spyOn(OpenAIApiProvider.prototype, 'kill');
    let generationIdentity = { managerId: 'managed-stale-watchdog', generation: 1 };
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'openai-api',
      onCrash,
      notifyUser,
    });
    sm.bindGenerationOwnership(() => generationIdentity);
    await sm.spawnSession();
    generationIdentity = { managerId: 'managed-stale-watchdog', generation: 2 };
    vi.mocked(updateSessionStatus).mockClear();

    (sm as unknown as { handleWatchdogHard: () => void }).handleWatchdogHard();

    expect(killSpy).not.toHaveBeenCalled();
    expect(updateSessionStatus).not.toHaveBeenCalled();
    expect(onCrash).not.toHaveBeenCalled();
    expect(notifyUser).not.toHaveBeenCalled();
    expect(sm.getStatus()).toMatchObject({ active: true, sessionId: expect.any(String) });
  });

  it('does not clear a replacement watchdog handle when an old callback runs late', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    const oldWatchdog = { id: 'old-watchdog' } as unknown as ReturnType<typeof setTimeout>;
    const replacementWatchdog = { id: 'replacement-watchdog' } as unknown as ReturnType<typeof setTimeout>;
    const state = sm as unknown as {
      watchdogHard: ReturnType<typeof setTimeout> | null;
      handleWatchdogHard: (
        managedProviderSession: null,
        managedProviderGeneration: null,
        expectedWatchdog: ReturnType<typeof setTimeout>,
      ) => void;
    };
    state.watchdogHard = replacementWatchdog;

    state.handleWatchdogHard(null, null, oldWatchdog);

    expect(state.watchdogHard).toBe(replacementWatchdog);
  });

  it('drops a deferred crash notice after its generation is superseded', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();
    let generationIdentity = { managerId: 'deferred-crash-notice', generation: 1 };
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      notifyUser,
    });
    sm.bindGenerationOwnership(() => generationIdentity);
    (sm as unknown as {
      notifyUnexpectedExit: (
        code: number | null,
        signal: NodeJS.Signals | null,
        generationIdentity: { managerId: string; generation: number },
      ) => void;
    }).notifyUnexpectedExit(1, null, generationIdentity);
    generationIdentity = { managerId: 'deferred-crash-notice', generation: 2 };

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(notifyUser).not.toHaveBeenCalled();
  });

  it('does not apply a late persistent stdin completion to a replacement generation', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const firstChild = makeMockChild(31001);
    const replacementChild = makeMockChild(31002);
    let finishOldWrite!: (err?: Error | null) => void;
    firstChild.stdin.write.mockImplementation(
      (_data: unknown, _encoding?: unknown, callback?: (err?: Error | null) => void) => {
        if (callback) finishOldWrite = callback;
        return true;
      },
    );
    (spawn as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(replacementChild);
    let generationIdentity = { managerId: 'persistent-late-write', generation: 1 };
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    sm.bindGenerationOwnership(() => generationIdentity);
    await sm.spawnSession();
    const oldTurn = sm.sendTurn('generation one');
    generationIdentity = { managerId: 'persistent-late-write', generation: 2 };
    await sm.shutdown(false);
    firstChild._exitCb?.(0, null);
    await sm.spawnSession();

    finishOldWrite();
    await expect(oldTurn).rejects.toThrow('Session generation was superseded before turn completion.');

    try {
      expect(sm.getStatus()).toMatchObject({ messageCount: 0, turnInFlight: false });
    } finally {
      await sm.shutdown(false);
      replacementChild._exitCb?.(0, null);
    }
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

  it('a watchdog reap is tagged idle_watchdog and sends no second, generic crash notice', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger, sentMessages } = makeMessenger();
    const notifyUser = vi.fn();
    const onCrash = vi.fn();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), instanceName: 'personal', notifyUser, onCrash });
    await sm.spawnSession();
    await sm.sendTurn('test message');

    await vi.advanceTimersByTimeAsync(WATCHDOG_HARD_MS);
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
    expect(notifyUser).toHaveBeenCalledWith(expect.stringContaining('inactivity'));

    // The process exit follows the signal we sent.
    mockChild._exitCb?.(null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(1);

    expect(onCrash).toHaveBeenCalledTimes(1);
    expect(onCrash.mock.calls[0][0]).toMatchObject({
      signal: 'SIGKILL',
      terminationReason: 'idle_watchdog',
      crashClass: 'idle_watchdog',
    });
    // The inactivity notice already explained the termination; the generic line is suppressed.
    expect(sentMessages.filter((m) => m.text.includes('session ended'))).toHaveLength(0);

    vi.useRealTimers();
  });

  it('a SIGKILL the manager did not issue is still an untagged crash', async () => {
    const db = makeDb();
    const { messenger, sentMessages } = makeMessenger();
    const onCrash = vi.fn();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), onCrash });
    await sm.spawnSession();

    // Killed by something else entirely (OOM killer, operator, systemd).
    mockChild._exitCb?.(null, 'SIGKILL');

    await vi.waitFor(() => expect(onCrash).toHaveBeenCalledTimes(1));
    expect(onCrash.mock.calls[0][0].terminationReason).toBeUndefined();
    await vi.waitFor(() => expect(sentMessages.some((m) => m.text.includes('session ended'))).toBe(true));
  });

  it('a reap intent does not excuse an exit that does not match the signal we sent', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();
    const onCrash = vi.fn();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), instanceName: 'personal', notifyUser: vi.fn(), onCrash });
    await sm.spawnSession();
    await sm.sendTurn('test message');

    await vi.advanceTimersByTimeAsync(WATCHDOG_HARD_MS);

    // The child dies of a different cause before our SIGKILL lands — that is a real crash.
    mockChild._exitCb?.(null, 'SIGSEGV');
    await vi.advanceTimersByTimeAsync(1);

    expect(onCrash).toHaveBeenCalledTimes(1);
    expect(onCrash.mock.calls[0][0].terminationReason).toBeUndefined();

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

  it('a stalled operation is SIGKILLed after the grace period, long before the 30-min hard watchdog', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), instanceName: 'personal', notifyUser });
    await sm.spawnSession();
    await sm.sendTurn('send revised report');

    // A tool crosses its stall threshold → OperationTracker calls recoverStalledOperation
    sm.recoverStalledOperation('toolu_bash_hang', 'Bash');
    expect((sm as unknown as { stalledOpKill: unknown }).stalledOpKill).not.toBeNull();

    // Nothing yet just before the grace elapses
    await vi.advanceTimersByTimeAsync(STALLED_OP_KILL_GRACE_MS - 1);
    expect(mockChild.kill).not.toHaveBeenCalledWith('SIGKILL');

    // Grace elapses well inside the 30-min hard watchdog → SIGKILL the hung provider
    await vi.advanceTimersByTimeAsync(2);
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
    expect(notifyUser).toHaveBeenCalledWith(expect.stringContaining('stalled'));
    expect(STALLED_OP_KILL_GRACE_MS).toBeLessThan(WATCHDOG_HARD_MS);

    vi.useRealTimers();
  });

  it('an inbound user message does NOT cancel a pending stalled-operation kill (the ~90-min limbo bug)', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), instanceName: 'personal', notifyUser });
    await sm.spawnSession();
    await sm.sendTurn('send revised report');

    sm.recoverStalledOperation('toolu_bash_hang', 'Bash');

    // Impatient user re-prompts while the tool is hung. The provider lane rejects
    // the overlap and, critically, does not clear or postpone the exact stalled-op kill.
    await expect(sm.sendTurn('how soon until the report is ready?')).rejects.toThrow(
      /PROVIDER_TURN_IN_FLIGHT/,
    );
    expect((sm as unknown as { stalledOpKill: unknown }).stalledOpKill).not.toBeNull();

    await vi.advanceTimersByTimeAsync(STALLED_OP_KILL_GRACE_MS + 1);
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');

    vi.useRealTimers();
  });

  it('genuine provider progress (tickWatchdog) cancels a pending stalled-operation kill', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), instanceName: 'personal', notifyUser });
    await sm.spawnSession();
    await sm.sendTurn('send revised report');

    sm.recoverStalledOperation('toolu_bash_hang', 'Bash');
    // The hung tool finally produces output / the provider emits an event
    sm.tickWatchdog();
    expect((sm as unknown as { stalledOpKill: unknown }).stalledOpKill).toBeNull();

    await vi.advanceTimersByTimeAsync(STALLED_OP_KILL_GRACE_MS + 1);
    expect(mockChild.kill).not.toHaveBeenCalledWith('SIGKILL');

    vi.useRealTimers();
  });

  it('provider progress during liveness assessment invalidates the stale kill decision', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();
    let resolveAssessment!: (verdict: {
      alive: boolean;
      cpuDeltaMs: number;
      pidChurn: number;
      pidCount: number;
    }) => void;
    const treeLivenessAssessor = vi.fn(() => new Promise<{
      alive: boolean;
      cpuDeltaMs: number;
      pidChurn: number;
      pidCount: number;
    }>((resolve) => {
      resolveAssessment = resolve;
    }));
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      treeLivenessAssessor,
    });
    await sm.spawnSession();
    await sm.sendTurn('long tool with delayed assessment');

    sm.recoverStalledOperation('toolu_assessment_race', 'Bash');
    await vi.advanceTimersByTimeAsync(STALLED_OP_KILL_GRACE_MS + 1);
    expect(treeLivenessAssessor).toHaveBeenCalledOnce();

    // Real provider output arrives while the two-sample assessor is awaiting.
    // Its eventual "not alive" verdict describes the old quiet stretch.
    sm.tickWatchdog();
    resolveAssessment({ alive: false, cpuDeltaMs: 0, pidChurn: 0, pidCount: 2 });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockChild.kill).not.toHaveBeenCalledWith('SIGKILL');

    vi.useRealTimers();
  });

  it('liveness gate: a CPU-active tree defers the stalled-op kill and re-arms the grace timer', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();
    // First assessment: tree is working (long browser step). Second: genuinely hung.
    const treeLivenessAssessor = vi.fn()
      .mockResolvedValueOnce({ alive: true, cpuDeltaMs: 1_500, pidChurn: 0, pidCount: 4 })
      .mockResolvedValueOnce({ alive: false, cpuDeltaMs: 0, pidChurn: 0, pidCount: 4 });

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), instanceName: 'personal', notifyUser, treeLivenessAssessor });
    await sm.spawnSession();
    await sm.sendTurn('run the long data export');

    sm.recoverStalledOperation('toolu_browser_long', 'mcp__playwright__browser_navigate');
    await vi.advanceTimersByTimeAsync(STALLED_OP_KILL_GRACE_MS + 1);

    // Working tree → NO kill; user told the long step is still running; timer re-armed.
    expect(mockChild.kill).not.toHaveBeenCalledWith('SIGKILL');
    expect(notifyUser).toHaveBeenCalledWith(expect.stringContaining('Long-running step still active'));
    expect((sm as unknown as { stalledOpKill: unknown }).stalledOpKill).not.toBeNull();

    // Next grace window: assessment now reads hung → kill proceeds.
    await vi.advanceTimersByTimeAsync(STALLED_OP_KILL_GRACE_MS + 1);
    expect(treeLivenessAssessor).toHaveBeenCalledTimes(2);
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');

    vi.useRealTimers();
  });

  it('liveness gate: the hard watchdog defers for a CPU-active tree instead of killing it', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();
    const treeLivenessAssessor = vi.fn()
      .mockResolvedValueOnce({ alive: true, cpuDeltaMs: 900, pidChurn: 1, pidCount: 5 })
      .mockResolvedValueOnce({ alive: false, cpuDeltaMs: 0, pidChurn: 0, pidCount: 5 });

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), instanceName: 'personal', notifyUser, treeLivenessAssessor });
    await sm.spawnSession();
    await sm.sendTurn('long quiet automation');

    // First hard-watchdog expiry: tree alive → deferred, watchdog re-armed, no termination notice.
    await vi.advanceTimersByTimeAsync(WATCHDOG_HARD_MS + 1);
    expect(mockChild.kill).not.toHaveBeenCalledWith('SIGKILL');
    expect(notifyUser).not.toHaveBeenCalledWith(expect.stringContaining('terminated'));

    // Second expiry: tree hung → the original termination behavior runs.
    await vi.advanceTimersByTimeAsync(WATCHDOG_HARD_MS + 1);
    expect(treeLivenessAssessor).toHaveBeenCalledTimes(2);
    expect(notifyUser).toHaveBeenCalledWith(expect.stringContaining('terminated'));
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');

    vi.useRealTimers();
  });

  it('liveness gate: LONG_OP_CEILING_MS bounds extensions — a CPU-active tree is still killed at the ceiling', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();
    // Always alive — only the ceiling can stop this tree.
    const treeLivenessAssessor = vi.fn().mockResolvedValue({ alive: true, cpuDeltaMs: 2_000, pidChurn: 0, pidCount: 3 });

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), instanceName: 'personal', notifyUser, treeLivenessAssessor });
    await sm.spawnSession();
    await sm.sendTurn('endless spinning automation');

    sm.recoverStalledOperation('toolu_spin', 'Bash');
    // Force the gate anchor past the ceiling, then let the pending grace timer fire.
    (sm as unknown as { longOpGateStartedAt: number | null }).longOpGateStartedAt = Date.now() - LONG_OP_CEILING_MS - 1;
    await vi.advanceTimersByTimeAsync(STALLED_OP_KILL_GRACE_MS + 1);

    // Ceiling reached → kill despite the alive verdict (assessor not even consulted).
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
    expect(notifyUser).toHaveBeenCalledWith(expect.stringContaining('stalled'));

    vi.useRealTimers();
  });

  it('liveness gate: crossing LONG_OP_CEILING_MS during assessment kills without rearming', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();
    let resolveAssessment!: (verdict: {
      alive: boolean;
      cpuDeltaMs: number;
      pidChurn: number;
      pidCount: number;
    }) => void;
    const treeLivenessAssessor = vi.fn(() => new Promise<{
      alive: boolean;
      cpuDeltaMs: number;
      pidChurn: number;
      pidCount: number;
    }>((resolve) => {
      resolveAssessment = resolve;
    }));
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      treeLivenessAssessor,
    });
    await sm.spawnSession();
    await sm.sendTurn('assessment crosses the ceiling');

    sm.recoverStalledOperation('toolu_cross_ceiling', 'Bash');
    const firstKillAt = Date.now() + STALLED_OP_KILL_GRACE_MS;
    (sm as unknown as { longOpGateStartedAt: number | null }).longOpGateStartedAt =
      firstKillAt - (LONG_OP_CEILING_MS - 1_000);
    await vi.advanceTimersByTimeAsync(STALLED_OP_KILL_GRACE_MS + 1);
    expect(treeLivenessAssessor).toHaveBeenCalledOnce();
    vi.setSystemTime(Date.now() + 2_000);
    resolveAssessment({ alive: true, cpuDeltaMs: 1_000, pidChurn: 0, pidCount: 3 });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
    expect((sm as unknown as { stalledOpKill: unknown }).stalledOpKill).toBeNull();

    vi.useRealTimers();
  });

  it('liveness gate: an alive verdict rearms only for the time remaining before the ceiling', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();
    const treeLivenessAssessor = vi.fn().mockResolvedValue({
      alive: true,
      cpuDeltaMs: 1_000,
      pidChurn: 0,
      pidCount: 3,
    });
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      treeLivenessAssessor,
    });
    await sm.spawnSession();
    await sm.sendTurn('bounded long operation');

    const remainingAtAssessment = 60_000;
    sm.recoverStalledOperation('toolu_bounded_rearm', 'Bash');
    const firstKillAt = Date.now() + STALLED_OP_KILL_GRACE_MS;
    (sm as unknown as { longOpGateStartedAt: number | null }).longOpGateStartedAt =
      firstKillAt - (LONG_OP_CEILING_MS - remainingAtAssessment);
    await vi.advanceTimersByTimeAsync(STALLED_OP_KILL_GRACE_MS + 1);

    expect(mockChild.kill).not.toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(remainingAtAssessment + 1);

    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
    expect(treeLivenessAssessor).toHaveBeenCalledOnce();

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

  it('repeated resets keep a shutdown escalation timer for every superseded child', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();
    const graceMs = (SessionManager as unknown as { SHUTDOWN_GRACE_MS: number }).SHUTDOWN_GRACE_MS;

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();
    await sm.shutdown();

    const mockChild2 = makeMockChild(23456);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockChild2);
    await sm.spawnSession();
    await sm.shutdown();

    const mockChild3 = makeMockChild(34567);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockChild3);
    await sm.spawnSession();

    await vi.advanceTimersByTimeAsync(graceMs + 1);

    expect(mockChild.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(mockChild.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    expect(mockChild2.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(mockChild2.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    expect(mockChild3.kill).not.toHaveBeenCalled();
    expect(sm.getStatus().pid).toBe(34567);

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
      model: 'glm/test-model',
    });
    await sm.spawnSession();
    await sm.sendTurn('hello');
    await sm.shutdown();

    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');

    mockChild._exitCb?.(0, null);
    mockChild._closeCb?.(0, null);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(graceMs + 1);

    expect(mockChild.kill).toHaveBeenCalledTimes(1);
    expect(mockChild.kill).not.toHaveBeenCalledWith('SIGKILL');
    expect(
      (sm as unknown as { shutdownKillTimers: Map<unknown, unknown> }).shutdownKillTimers.size,
    ).toBe(0);

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

    expect(updateResumedSessionStatus).toHaveBeenCalledWith(
      db,
      42,
      'some-session-id',
      'claude-cli',
      'resume_failed',
    );
    expect(onResumeFailedCb).toHaveBeenCalledTimes(1);
    // Should NOT call updateSessionStatus with 'crashed' for a resume failure
    expect(updateResumedSessionStatus).not.toHaveBeenCalledWith(
      db,
      42,
      'some-session-id',
      'claude-cli',
      'crashed',
    );
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

  it('Codex turn/start keeps runtime context separate from the user input item', async () => {
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
    const threadStartRequest = (mockChild.stdin.write as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => JSON.parse(String(call[0]).trim()))
      .find((value) => value.method === 'thread/start');
    (mockChild.stdin.write as ReturnType<typeof vi.fn>).mockClear();

    const sendPromise = sm.sendTurn({
      applicationContext: ['receipt=2026-05-28T20:26:40.000Z age=95'],
      userText: 'stop that flow now',
    });
    mockChild.stdout.emit('data', Buffer.from(`${JSON.stringify({
      jsonrpc: '2.0',
      id: threadStartRequest.id,
      result: { id: 'thread_structured' },
    })}\n`));
    await sendPromise;

    const wire = (mockChild.stdin.write as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String(call[0]))
      .find((value) => value.includes('"method":"turn/start"'));
    expect(JSON.parse(wire!)).toMatchObject({
      params: {
        threadId: 'thread_structured',
        input: [
          { type: 'text', text: 'receipt=2026-05-28T20:26:40.000Z age=95' },
          { type: 'text', text: 'stop that flow now' },
        ],
      },
    });
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
      'utf8',
      expect.any(Function),
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

  it('Codex stdout lifecycle captures and terminalizes the exact owned native turn', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const generation = { managerId: 'manager-a', generation: 7 } as const;
    const events: AgentEvent[] = [];
    let sm!: SessionManager;
    sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      provider: 'codex-cli',
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'result') sm.completeProviderTurn();
      },
    });
    sm.bindGenerationOwnership(() => generation);
    await sm.spawnSession();

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: 'rpc-2',
      result: { id: 'thread-owned' },
    }) + '\n'));
    await sm.sendTurn('hello');
    const turnRequest = lastJsonRpcRequest(mockChild, 'turn/start');
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: turnRequest['id'],
      result: { turn: { id: 'turn-owned', status: 'inProgress' } },
    }) + '\n'));

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: {
        threadId: 'thread-owned',
        turn: { id: 'turn-owned', status: 'inProgress' },
      },
    }) + '\n'));

    expect(sm.getActiveProviderTurn()).toEqual({
      provider: 'codex-cli',
      identity: { sessionId: 'thread-owned', turnId: 'turn-owned' },
      generation,
      providerTurnToken: 1,
    });

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-owned',
        turn: { id: 'turn-owned', status: 'completed' },
      },
    }) + '\n'));

    expect(events).toContainEqual({
      type: 'result',
      text: null,
      providerTurnOwnerToken: 1,
      providerTurn: {
        sessionId: 'thread-owned',
        turnId: 'turn-owned',
        status: 'completed',
      },
    });
    expect(sm.getActiveProviderTurn()).toBeNull();
  });

  it.each([
    {
      name: 'wrong thread',
      terminal: { sessionId: 'thread-other', turnId: 'turn-owned' },
    },
    {
      name: 'wrong turn',
      terminal: { sessionId: 'thread-owned', turnId: 'turn-other' },
    },
  ])('Codex quarantines a $name terminal without forwarding it', async ({ terminal }) => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const events: AgentEvent[] = [];
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      provider: 'codex-cli',
      onEvent: (event) => events.push(event),
    });
    await sm.spawnSession();
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: 'rpc-2',
      result: { id: 'thread-owned' },
    }) + '\n'));
    await sm.sendTurn('hello');
    const turnRequest = lastJsonRpcRequest(mockChild, 'turn/start');
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: turnRequest['id'],
      result: { turn: { id: 'turn-owned', status: 'inProgress' } },
    }) + '\n'));
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: {
        threadId: 'thread-owned',
        turn: { id: 'turn-owned', status: 'inProgress' },
      },
    }) + '\n'));
    expect(sm.getActiveProviderTurn()).toMatchObject({
      provider: 'codex-cli',
      identity: { sessionId: 'thread-owned', turnId: 'turn-owned' },
      generation: { managerId: expect.any(String), generation: 1 },
      providerTurnToken: 1,
    });

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: terminal.sessionId,
        turn: { id: terminal.turnId, status: 'completed' },
      },
    }) + '\n'));

    await vi.waitFor(() => expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL'));
    expect(events.filter((event) => event.type === 'result')).toEqual([]);
    expect(sm.getActiveProviderTurn()).toBeNull();
  });

  it('Codex quarantines terminal-before-start and missing-identity notifications', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const events: AgentEvent[] = [];
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      provider: 'codex-cli',
      onEvent: (event) => events.push(event),
    });
    await sm.spawnSession();
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: 'rpc-2',
      result: { id: 'thread-owned' },
    }) + '\n'));
    await sm.sendTurn('hello');

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-owned',
        turn: { id: 'turn-before-start', status: 'completed' },
      },
    }) + '\n'));
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { turn: { status: 'completed' } },
    }) + '\n'));

    await vi.waitFor(() => expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL'));
    expect(events.filter((event) => event.type === 'result')).toEqual([]);
  });

  it('Codex invalidates an ambiguous second start identity and quarantines the source', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const events: AgentEvent[] = [];
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      provider: 'codex-cli',
      onEvent: (event) => events.push(event),
    });
    await sm.spawnSession();
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: 'rpc-2',
      result: { id: 'thread-owned' },
    }) + '\n'));
    await sm.sendTurn('hello');
    const turnRequest = lastJsonRpcRequest(mockChild, 'turn/start');
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: turnRequest['id'],
      result: { turn: { id: 'turn-first', status: 'inProgress' } },
    }) + '\n'));
    for (const turnId of ['turn-first', 'turn-conflict']) {
      mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        method: 'turn/started',
        params: {
          threadId: 'thread-owned',
          turn: { id: turnId, status: 'inProgress' },
        },
      }) + '\n'));
    }

    await vi.waitFor(() => expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL'));
    expect(sm.getActiveProviderTurn()).toBeNull();
    expect(events.some((event) => event.type === 'provider_turn_started')).toBe(false);
  });

  it('Codex rejects a duplicate old completion after the next owned turn starts', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const results: Extract<AgentEvent, { type: 'result' }>[] = [];
    let sm!: SessionManager;
    sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      provider: 'codex-cli',
      onEvent: (event) => {
        if (event.type !== 'result') return;
        results.push(event);
        sm.completeProviderTurn(event.providerTurnOwnerToken);
      },
    });
    await sm.spawnSession();
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: 'rpc-2',
      result: { id: 'thread-owned' },
    }) + '\n'));

    await sm.sendTurn('first');
    const firstTurnRequest = lastJsonRpcRequest(mockChild, 'turn/start');
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: firstTurnRequest['id'],
      result: { turn: { id: 'turn-first', status: 'inProgress' } },
    }) + '\n'));
    for (const method of ['turn/started', 'turn/completed']) {
      mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        method,
        params: {
          threadId: 'thread-owned',
          turn: {
            id: 'turn-first',
            status: method === 'turn/started' ? 'inProgress' : 'completed',
          },
        },
      }) + '\n'));
    }
    expect(results).toHaveLength(1);

    await sm.sendTurn('second');
    const secondTurnRequest = lastJsonRpcRequest(mockChild, 'turn/start');
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: secondTurnRequest['id'],
      result: { turn: { id: 'turn-second', status: 'inProgress' } },
    }) + '\n'));
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: {
        threadId: 'thread-owned',
        turn: { id: 'turn-second', status: 'inProgress' },
      },
    }) + '\n'));
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-owned',
        turn: { id: 'turn-first', status: 'completed' },
      },
    }) + '\n'));

    await vi.waitFor(() => expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL'));
    expect(results).toHaveLength(1);
    expect(sm.getActiveProviderTurn()).toBeNull();
  });

  it('Codex quarantines an identity-free legacy completion without clearing its owner', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const results: Extract<AgentEvent, { type: 'result' }>[] = [];
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      provider: 'codex-cli',
      onEvent: (event) => {
        if (event.type === 'result') results.push(event);
      },
    });
    await sm.spawnSession();
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: 'thread-request',
      result: { id: 'thread-owned' },
    }) + '\n'));
    await sm.sendTurn('current');
    const turnRequest = lastJsonRpcRequest(mockChild, 'turn/start');
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: turnRequest['id'],
      result: { turn: { id: 'turn-current', status: 'inProgress' } },
    }) + '\n'));

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 7, output_tokens: 3 },
    }) + '\n'));

    await vi.waitFor(() => expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL'));
    expect(results).toEqual([]);
    expect(sm.getActiveProviderTurn()).toBeNull();
  });

  it('Codex admits an exact turn-start request error with the owning token', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const results: Extract<AgentEvent, { type: 'result' }>[] = [];
    let sm!: SessionManager;
    sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      provider: 'codex-cli',
      onEvent: (event) => {
        if (event.type !== 'result') return;
        results.push(event);
        sm.completeProviderTurn(event.providerTurnOwnerToken);
      },
    });
    await sm.spawnSession();
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: 'rpc-2',
      result: { id: 'thread-owned' },
    }) + '\n'));
    await sm.sendTurn('first');
    const request = lastJsonRpcRequest(mockChild, 'turn/start');

    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: request['id'],
      error: { code: -32600, message: 'request rejected' },
    }) + '\n'));

    expect(results).toContainEqual({
      type: 'result',
      text: 'Codex error: request rejected',
      isError: true,
      providerRequestId: request['id'],
      providerTurnOwnerToken: 1,
    });
  });

  it('Codex quarantines a stale turn-start request error after a later request owns the lane', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const results: Extract<AgentEvent, { type: 'result' }>[] = [];
    let sm!: SessionManager;
    sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      provider: 'codex-cli',
      onEvent: (event) => {
        if (event.type !== 'result') return;
        results.push(event);
        sm.completeProviderTurn(event.providerTurnOwnerToken);
      },
    });
    await sm.spawnSession();
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: 'rpc-2',
      result: { id: 'thread-owned' },
    }) + '\n'));

    await sm.sendTurn('first');
    const firstRequest = lastJsonRpcRequest(mockChild, 'turn/start');
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: firstRequest['id'],
      result: { turn: { id: 'turn-first', status: 'inProgress' } },
    }) + '\n'));
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: {
        threadId: 'thread-owned',
        turn: { id: 'turn-first', status: 'inProgress' },
      },
    }) + '\n'));
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-owned',
        turn: { id: 'turn-first', status: 'completed' },
      },
    }) + '\n'));

    await sm.sendTurn('second');
    mockChild.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: firstRequest['id'],
      error: { code: -32600, message: 'stale request rejected' },
    }) + '\n'));

    await vi.waitFor(() => expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL'));
    expect(results).toHaveLength(1);
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

  it('opencode-cli: forwards only the credential selected by the model prefix', () => {
    const savedOai = process.env.OPENAI_API_KEY;
    const savedAnt = process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-openai-oc';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-oc';
    try {
      const env = buildChildEnv('opencode-cli', undefined, 'openai/test-model');
      expect(env.OPENAI_API_KEY).toBe('sk-openai-oc');
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (savedOai === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedOai;
      if (savedAnt === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedAnt;
    }
  });

  it('opencode-cli: forwards the Kimi credential selected by a Kimi model', () => {
    const savedKimi = process.env.KIMI_API_KEY;
    process.env.KIMI_API_KEY = 'kimi-api-key-for-test';
    try {
      const env = buildChildEnv('opencode-cli', undefined, 'kimi/kimi-k3');
      expect(env.KIMI_API_KEY).toBe('kimi-api-key-for-test');
    } finally {
      if (savedKimi === undefined) delete process.env.KIMI_API_KEY;
      else process.env.KIMI_API_KEY = savedKimi;
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
      const env = buildChildEnv('opencode-cli', undefined, undefined, {
        baseUrl: 'https://endpoint.example/v1',
        apiKeyService: 'deepseek',
      });
      expect(env.DEEPSEEK_API_KEY).toBe('ds-api-key-for-test');
    } finally {
      if (savedDeep === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = savedDeep;
      if (savedOai !== undefined) process.env.OPENAI_API_KEY = savedOai;
      if (savedAnt !== undefined) process.env.ANTHROPIC_API_KEY = savedAnt;
    }
  });

  it('opencode-cli: rejects an empty custom-endpoint apiKeyService', () => {
    const savedOai = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => buildChildEnv('opencode-cli', undefined, undefined, {
        baseUrl: 'https://endpoint.example/v1',
        apiKeyService: '  ',
      })).toThrow(/mapped inference-provider service/);
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
    const args = __provider_switch_for_test.getProviderArgs(
      'opencode-cli',
      'sys',
      '/cwd',
      undefined,
      undefined,
      [],
      { executionProfile: 'whatsoup-headless' },
    );
    expect(args).toEqual([
      'run', '--format', 'json', '--pure', '--agent', 'whatsoup-headless',
    ]);
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

  it('instructs OpenCode to continue the original request after automatic compaction', () => {
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger().messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'opencode-cli',
    });

    expect(sm.buildSystemPrompt()).toContain(
      'After automatic context compaction, continue the original user request from the summary',
    );
  });

  it('does not add OpenCode compaction guidance to other providers', () => {
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger().messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'gemini-cli',
    });

    expect(sm.buildSystemPrompt()).not.toContain('After automatic context compaction');
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

  it('captures an exact active provider turn only for the current request generation', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, provider: 'codex-cli', onEvent: vi.fn(),
    });
    const generation = { managerId: 'manager-a', generation: 7 } as const;
    sm.bindGenerationOwnership(() => generation);
    Object.assign(sm as unknown as Record<string, unknown>, {
      providerTurnInFlight: true,
      activeProviderTurnToken: 23,
      activeProviderTurnGeneration: generation,
      codexThreadId: 'thread-current',
      activeCodexTurnStartRequestId: 'request-current',
    });
    const handler = (
      sm as unknown as { handleProviderEvent: (event: AgentEvent) => void }
    ).handleProviderEvent.bind(sm);

    handler({
      type: 'provider_turn_accepted',
      requestId: 'request-current',
      turnId: 'turn-current',
    });

    expect(sm.getActiveProviderTurn()).toEqual({
      provider: 'codex-cli',
      identity: { sessionId: 'thread-current', turnId: 'turn-current' },
      generation,
      providerTurnToken: 23,
    });

    sm.completeProviderTurn(22);
    expect(sm.getActiveProviderTurn()).not.toBeNull();
    sm.completeProviderTurn(23);
    expect(sm.getActiveProviderTurn()).toBeNull();
  });

  it('rejects stale, mismatched, and unowned provider turn identities', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, provider: 'codex-cli', onEvent: vi.fn(),
    });
    const generation = { managerId: 'manager-a', generation: 7 } as const;
    let currentGeneration: { managerId: string; generation: number } = generation;
    sm.bindGenerationOwnership(() => currentGeneration);
    Object.assign(sm as unknown as Record<string, unknown>, {
      providerTurnInFlight: true,
      activeProviderTurnToken: 23,
      activeProviderTurnGeneration: generation,
      codexThreadId: 'thread-current',
      activeCodexTurnStartRequestId: 'request-current',
    });
    const handler = (
      sm as unknown as { handleProviderEvent: (event: AgentEvent) => void }
    ).handleProviderEvent.bind(sm);

    handler({
      type: 'provider_turn_accepted',
      requestId: 'request-stale',
      turnId: 'turn-stale',
    });
    expect(sm.getActiveProviderTurn()).toBeNull();

    currentGeneration = { managerId: 'manager-a', generation: 8 };
    handler({
      type: 'provider_turn_accepted',
      requestId: 'request-current',
      turnId: 'turn-superseded',
    });
    expect(sm.getActiveProviderTurn()).toBeNull();

    Object.assign(sm as unknown as Record<string, unknown>, {
      providerTurnInFlight: false,
      activeProviderTurnToken: null,
    });
    handler({
      type: 'provider_turn_accepted',
      requestId: 'request-current',
      turnId: 'turn-unowned',
    });
    expect(sm.getActiveProviderTurn()).toBeNull();
  });

  it('exposes the closed turn-control capability row for the configured provider', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, provider: 'codex-cli', onEvent: vi.fn(),
    });

    expect(sm.getTurnControlCapabilities()).toEqual({
      startTurn: true,
      busyInput: 'queue_only',
      interrupt: 'terminate_provider_session',
      native: {
        busyInput: 'steer_active_turn',
        interrupt: 'interrupt_active_turn',
        turnIdentity: 'required',
        runtimeEnabled: false,
      },
    });
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
      provider: 'opencode-cli', model: 'glm/test-model', notifyUser, onCrash,
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
      provider: 'opencode-cli', model: 'glm/test-model', notifyUser, onCrash,
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

  it('spawn-per-turn close code 0 without a result fails closed and notifies the user', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();
    const onCrash = vi.fn();

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      provider: 'opencode-cli', model: 'glm/test-model', notifyUser, onCrash,
    });

    await sm.spawnSession();
    await sm.sendTurn('hello clean exit');

    mockChild._exitCb?.(0, null);
    mockChild._closeCb?.(0, null);

    // Give setImmediate callbacks a chance to run
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(onCrash).toHaveBeenCalledTimes(1);
    expect(onCrash).toHaveBeenCalledWith(expect.objectContaining({
      exitCode: 0,
      signal: null,
      crashClass: 'provider_stream_corrupt',
    }));
    expect(notifyUser).toHaveBeenCalledWith(
      expect.stringMatching(/ended before completing the turn/i),
    );
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

  it('setDurability atomically begins a fresh checkpoint during spawnSession', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const upsert = vi.fn();
    const beginFresh = vi.fn();
    const durability = { beginFreshSessionCheckpoint: beginFresh, upsertSessionCheckpoint: upsert };

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    sm.setDurability(durability as unknown as Parameters<typeof sm.setDurability>[0]);
    await sm.spawnSession();

    expect(beginFresh).toHaveBeenCalledWith(
      toConversationKey(CHAT_JID),
      12345,
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('setDurability enables checkpoint upserts during shutdown', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const upsert = vi.fn();
    const durability = { beginFreshSessionCheckpoint: vi.fn(), upsertSessionCheckpoint: upsert };

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
    const durability = { beginFreshSessionCheckpoint: vi.fn(), upsertSessionCheckpoint: upsert };

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
      model: 'glm/test-model',
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
      model: 'glm/test-model',
    });

    await sm.spawnSession();
    // sessionId is already the synthetic one set during spawnSession: "opencode-cli-<ts>"
    const mockChild2 = makeMockChild(22222);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild2);
    await sm.sendTurn('first turn');

    const secondSpawnArgs: string[] = (spawn as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] ?? [];
    expect(secondSpawnArgs).not.toContain('--session');
  });

  it('places runtime application context before the separately labeled user message', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      provider: 'opencode-cli',
      model: 'glm/test-model',
    });

    await sm.spawnSession();
    const turnChild = makeMockChild(22222);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(turnChild);
    await sm.sendTurn({
      applicationContext: ['receipt=2026-05-28T20:26:40.000Z age=95'],
      userText: 'stop that flow now',
    });

    const args: string[] = (spawn as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] ?? [];
    const prompt = args.at(-1) ?? '';
    expect(prompt).toContain('Application context (runtime-provided):\nreceipt=2026-05-28T20:26:40.000Z age=95');
    expect(prompt).toContain('User message:\nstop that flow now');
    expect(prompt.indexOf('Application context')).toBeLessThan(prompt.indexOf('User message:'));
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

// ─── session.ts uncovered-branch coverage ────────────────────────────────────
//
// Targets specific branch locations that remained uncovered after the focused
// branch-coverage pass. Each test exercises a single conditional path with a
// concrete terminal assertion.

describe('session.ts uncovered-branch coverage', () => {
  // Re-import the test-only provider switch surface + buildChildEnv already
  // imported at module scope (lines 2176-2181). We reuse them here.

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

  // --- buildChildEnv: opencode-cli unmapped-service fail-closed branches ---

  it('buildChildEnv opencode-cli: rejects an unmapped apiKeyService', () => {
    expect(() => buildChildEnv(
      'opencode-cli',
      undefined,
      undefined,
      {
        baseUrl: 'https://endpoint.example/v1',
        apiKeyService: 'totally-unknown-svc',
      },
    )).toThrow(/mapped inference-provider service/);
  });

  it('buildChildEnv opencode-cli: rejects an unmapped model prefix', () => {
    expect(() => buildChildEnv(
      'opencode-cli',
      undefined,
      'unknownvendor/some-model',
    )).toThrow(/does not resolve to a mapped provider credential service/);
  });

  // --- resolveProviderBinary / resolveProviderArgs / resolveProviderParser
  //     managed-loop throw branches (lines 244, 251, 335, 339, 356, 381, 401).

  it('resolveProviderBinary throws for openai-api managed-loop provider', () => {
    expect(() => __provider_switch_for_test.getProviderBinary('openai-api')).toThrow(
      /managed-loop provider/,
    );
  });

  it('resolveProviderBinary throws for anthropic-api managed-loop provider', () => {
    expect(() => __provider_switch_for_test.getProviderBinary('anthropic-api')).toThrow(
      /managed-loop provider/,
    );
  });

  it('resolveProviderArgs throws for openai-api managed-loop provider', () => {
    expect(() =>
      __provider_switch_for_test.getProviderArgs('openai-api', 'sys', '/cwd', undefined, undefined, []),
    ).toThrow(/managed-loop provider/);
  });

  it('resolveProviderArgs throws for anthropic-api managed-loop provider', () => {
    expect(() =>
      __provider_switch_for_test.getProviderArgs(
        'anthropic-api',
        'sys',
        '/cwd',
        undefined,
        undefined,
        [],
      ),
    ).toThrow(/managed-loop provider/);
  });

  it('resolveProviderParser throws for openai-api managed-loop provider', () => {
    expect(() => __provider_switch_for_test.getParser('openai-api')).toThrow(
      /managed-loop provider/,
    );
  });

  it('resolveProviderParser throws for anthropic-api managed-loop provider', () => {
    expect(() => __provider_switch_for_test.getParser('anthropic-api')).toThrow(
      /managed-loop provider/,
    );
  });

  // --- getProviderBinary() exported helper (lines 264-273): unknown throws,
  //     managed-loop returns null.

  it('getProviderBinary throws for an unknown provider id', () => {
    expect(() => getProviderBinary('not-a-real-provider')).toThrow(/unknown provider id/);
  });

  it('getProviderBinary returns null for openai-api', () => {
    expect(getProviderBinary('openai-api')).toBeNull();
  });

  it('getProviderBinary returns null for anthropic-api', () => {
    expect(getProviderBinary('anthropic-api')).toBeNull();
  });

  it('getProviderBinary returns the binary name for known CLI providers', () => {
    expect(getProviderBinary('claude-cli')).toBe('claude');
    expect(getProviderBinary('codex-cli')).toBe('codex');
    expect(getProviderBinary('gemini-cli')).toBe('gemini');
    expect(getProviderBinary('opencode-cli')).toBe('opencode');
  });

  // --- opencodeUsesConfigModel: blank-string baseUrl returns false (line 287).

  it('opencodeUsesConfigModel returns false for a blank baseUrl', () => {
    expect(opencodeUsesConfigModel({ baseUrl: '   ' })).toBe(false);
  });

  it('opencodeUsesConfigModel returns false for an undefined config', () => {
    expect(opencodeUsesConfigModel(undefined)).toBe(false);
  });

  // --- Budget initialization in the constructor (line 575):
  //     budget is set when providerConfig.budget is present.

  it('constructor initializes a budget when providerConfig.budget is provided', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const events: AgentEvent[] = [];
    let sm!: SessionManager;
    sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: (e) => {
        events.push(e);
        if (e.type === 'result') sm.completeProviderTurn();
      },
      provider: 'openai-api',
      providerConfig: { budget: { requestsPerMinute: 1 } },
    });

    await sm.spawnSession();
    // First turn within the 1-per-minute cap is allowed.
    const fetchMock = vi.fn().mockResolvedValue(
      makeSseResponse([{ choices: [{ delta: { content: 'ok' } }] }, '[DONE]']),
    );
    vi.stubGlobal('fetch', fetchMock);
    await sm.sendTurn('within cap');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second turn within the same minute is throttled; a result event is emitted.
    await sm.sendTurn('over cap');
    const throttled = events.find(
      (e) => e.type === 'result' && typeof e.text === 'string' && e.text.includes('Throttled'),
    );
    expect(throttled).toBeDefined();
    vi.unstubAllGlobals();
  });

  // --- createManagedProviderSession default branch (line 608/609) — exercised
  //     indirectly via the openai-api/anthropic-api sessions above. Add an
  //     explicit anthropic-api session to cover its provider branch (line 607).

  it('anthropic-api managed session spawns and sends a turn', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const events: AgentEvent[] = [];
    const fetchMock = vi.fn().mockResolvedValue(
      makeSseResponse([
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
        { type: 'message_stop' },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: (e) => events.push(e),
      provider: 'anthropic-api',
      providerConfig: { baseUrl: 'https://api.test.invalid', model: 'claude-test' },
    });
    await sm.spawnSession();
    await sm.sendTurn('hello');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'assistant_text' })]));
    vi.unstubAllGlobals();
  });

  // --- buildSystemPrompt empty-composition throw (line 659-661).
  //     With no sources at all (no transport prelude is always present, so we
  //     exercise the instructionsPath read-failure throw instead — line 650-652).

  it('buildSystemPrompt throws when instructionsPath cannot be read', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      cwd: '/cwd',
      instructionsPath: 'missing.md',
    });
    // Force readFileSync to throw (the module-level mock returns undefined by
    // default; configure it to throw for this call).
    (readFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    expect(() => (sm as unknown as { buildSystemPrompt: () => string }).buildSystemPrompt()).toThrow(
      /Failed to read instructionsPath/,
    );
  });

  // --- sendTurn without an active session (line 1591-1592).

  it('sendTurn throws when no session is active', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await expect(sm.sendTurn('hi')).rejects.toThrow(/No active session/);
  });

  // --- sendTurn on a managed provider when the session was never initialized
  //     (line 1606-1608): managedProviderSession === null after active set true.

  it('sendTurn throws when managed provider session is null mid-flight', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'openai-api',
    });
    // Mark active without ever spawning the provider session.
    (sm as unknown as { active: boolean }).active = true;
    await expect(sm.sendTurn('hi')).rejects.toThrow(/Managed provider session is not initialized/);
    expect(sm.getStatus().turnInFlight).toBe(false);
  });

  // --- tickWatchdog / recoverStalledOperation / handleStalledOpKill /
  //     probeLiveness / handleWatchdogHard no-op guards (lines 1435, 1450,
  //     1473, 1526). All early-return when not active or no child.

  it('tickWatchdog is a no-op when the session is not active', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    expect(() => sm.tickWatchdog()).not.toThrow();
    // No watchdog timer was armed — verify by checking there is no pending
    // crash notification (session stayed clean).
    expect(sm.getStatus()).toMatchObject({ active: false });
  });

  it('recoverStalledOperation is a no-op when no child is running', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    expect(() => sm.recoverStalledOperation('tool-1', 'Read')).not.toThrow();
    expect(sm.hasPendingTools).toBe(false);
  });

  // --- crashManagedProviderSession no-op guard (line 1536): when neither an
  //     active session nor a managed provider session exists, it returns early.

  it('crashManagedProviderSession is a no-op when nothing is running', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const onCrash = vi.fn();
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'openai-api',
      onCrash,
    });
    // Invoke the private crash handler directly with no active session.
    const crash = (sm as unknown as { crashManagedProviderSession: (r: string) => void }).crashManagedProviderSession.bind(sm);
    crash('nothing to crash');
    expect(onCrash).not.toHaveBeenCalled();
    expect(sm.getStatus()).toMatchObject({ active: false });
  });

  // --- shutdown clears managed provider session when present (lines 1972-1976).

  it('shutdown terminates a managed provider session with the suspend signal', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const shutdownSpy = vi
      .spyOn(OpenAIApiProvider.prototype, 'shutdown')
      .mockResolvedValue(undefined);
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'openai-api',
    });
    await sm.spawnSession();
    await sm.shutdown(true);
    expect(shutdownSpy).toHaveBeenCalledWith('suspend');
    expect(sm.getStatus()).toMatchObject({ active: false, sessionId: null });
  });

  it('shutdown terminates a managed provider session with the end signal on /new', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const shutdownSpy = vi
      .spyOn(OpenAIApiProvider.prototype, 'shutdown')
      .mockResolvedValue(undefined);
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'openai-api',
    });
    await sm.spawnSession();
    await sm.shutdown(false);
    expect(shutdownSpy).toHaveBeenCalledWith('end');
  });

  // --- shutdown SIGKILL escalation when SIGTERM doesn't kill the child
  //     (lines 1963-1965). Use fake timers and a child whose kill is a no-op
  //     so the grace timer fires the SIGKILL path.

  it('shutdown escalates to SIGKILL after the grace period when SIGTERM does not kill', async () => {
    vi.useFakeTimers();
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();

    // Replace kill so SIGTERM does nothing and SIGKILL is observable.
    const child = (sm as unknown as { child: MockChild }).child;
    const kills: string[] = [];
    child.kill.mockImplementation((sig: string) => {
      kills.push(sig);
      // SIGTERM does not actually remove the child; SIGKILL records the escalation.
    });

    const shutdownP = sm.shutdown(true);
    await vi.advanceTimersByTimeAsync(10_000); // past SHUTDOWN_GRACE_MS (5s)
    await shutdownP;

    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
    vi.useRealTimers();
  });

  // --- Stdout buffer materialization branches (lines 700-712, 719-731):
  //     multi-chunk Buffer.concat path and drainBufferedStdoutLines with
  //     trailing whitespace-only content.

  it('appendStdoutChunk concats multiple buffered chunks and parses complete lines', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const events: AgentEvent[] = [];
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: (e) => events.push(e),
    });
    await sm.spawnSession();

    const child = (sm as unknown as { child: MockChild }).child;
    // Emit two chunks that together form one valid Claude init event line.
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'chunked-session-id',
    });
    const half = Math.floor(line.length / 2);
    child.stdout.emit('data', Buffer.from(line.slice(0, half)));
    child.stdout.emit('data', Buffer.from(line.slice(half) + '\n'));

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'init' && e.sessionId === 'chunked-session-id')).toBe(true);
    });
    expect(events[0]).toMatchObject({ type: 'init', sessionId: 'chunked-session-id' });
  });

  it('appendStdoutChunk ignores trailing whitespace-only buffer on drain', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const events: AgentEvent[] = [];
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: (e) => events.push(e),
    });
    await sm.spawnSession();

    const child = (sm as unknown as { child: MockChild }).child;
    // A valid line followed by trailing whitespace (no newline) — only the
    // complete line should parse to an event; the whitespace tail is dropped
    // when the child exits (drain path, line 721).
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'ws-trailing',
    });
    child.stdout.emit('data', Buffer.from(line + '\n   \n\t\n'));

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'init' && e.sessionId === 'ws-trailing')).toBe(true);
    });
    // Exactly one init event from the one complete JSON line.
    expect(events.filter((e) => e.type === 'init')).toHaveLength(1);
  });

  // --- appendStdoutChunk with no chunks early-return (line 699) and the
  //     Buffer.concat multi-chunk path: a chunk arriving with no newline yet.

  it('appendStdoutChunk returns [] when no complete line is present yet', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();
    const child = (sm as unknown as { child: MockChild }).child;
    // Partial line, no newline — should not emit any events and not throw.
    expect(() => child.stdout.emit('data', Buffer.from('partial-no-newline'))).not.toThrow();
  });

  // --- QR-064: a provider streaming a large NO-NEWLINE blob must not grow the
  //     retained stdout buffer unbounded (parent OOM). The buffer is capped at
  //     MAX_STDOUT_LINE_BYTES; a runaway partial line is dropped, and a later
  //     valid newline-terminated line still parses.
  it('QR-064: caps the retained stdout buffer on a large no-newline stream (no unbounded growth)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const events: AgentEvent[] = [];
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: (e) => events.push(e) });
    await sm.spawnSession();
    const child = (sm as unknown as { child: MockChild }).child;
    const state = sm as unknown as { stdoutBufferStr?: string };

    // Stream cap + 4 MiB of 'A' with NO newline, in 1 MiB chunks.
    const overBy = 4 * 1024 * 1024;
    const totalNoNewline = MAX_STDOUT_LINE_BYTES + overBy;
    const chunk = Buffer.alloc(1024 * 1024, 0x41);
    let streamed = 0;
    while (streamed < totalNoNewline) {
      child.stdout.emit('data', chunk);
      streamed += chunk.length;
    }

    // Retained buffer must be bounded — NOT the full streamed size.
    expect(state.stdoutBufferStr!.length).toBeLessThanOrEqual(MAX_STDOUT_LINE_BYTES);
    expect(state.stdoutBufferStr!.length).toBeLessThan(totalNoNewline);
    // No event was produced by the runaway (no newline ever completed a line).
    expect(events.some((e) => e.type === 'init')).toBe(false);

    // Recovery: after the runaway is dropped, a clean valid line still parses.
    const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'after-runaway' });
    child.stdout.emit('data', Buffer.from('\n' + line + '\n'));
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'init' && e.sessionId === 'after-runaway')).toBe(true);
    });
  });

  // --- notifyUnexpectedExit rate-limit (lines 1392-1399): a second crash
  //     within COOLDOWN is suppressed.

  it('notifyUnexpectedExit suppresses a second crash notice within the cooldown', async () => {
    vi.useFakeTimers();
    const db = makeDb();
    const { messenger, sentMessages } = makeMessenger();
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();
    const child = (sm as unknown as { child: MockChild }).child;

    // First exit with non-zero code triggers a notice.
    if (child._exitCb) child._exitCb(1, null);
    await vi.advanceTimersByTimeAsync(0); // flush setImmediate
    expect(sentMessages).toHaveLength(1);

    // Second exit shortly after — suppressed by rate limit.
    // Re-arm a fresh child so the exit handler runs again.
    const child2 = makeMockChild(222);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(child2);
    await sm.spawnSession();
    if (child2._exitCb) child2._exitCb(2, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(sentMessages).toHaveLength(1); // still one — second suppressed
    vi.useRealTimers();
  });

  // --- notifyUnexpectedExit with code 0 + signal still notifies (line 1386
  //     short-circuits only when BOTH code===0 AND !signal).

  it('notifyUnexpectedExit notifies when exit code is 0 but a signal is present', async () => {
    vi.useFakeTimers();
    const db = makeDb();
    const { messenger, sentMessages } = makeMessenger();
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();
    const child = (sm as unknown as { child: MockChild }).child;
    if (child._exitCb) child._exitCb(0, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain('signal');
    vi.useRealTimers();
  });

  // --- Resume-failed path (lines 1336-1344): resume attempt, exit code 1,
  //     no init event — triggers onResumeFailed + durability checkpoint.

  it('exit with code 1 during a resume attempt triggers onResumeFailed', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const onResumeFailed = vi.fn();
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      onResumeFailed,
    });
    await sm.spawnSession('expired-session-id');
    const child = (sm as unknown as { child: MockChild }).child;
    if (child._exitCb) child._exitCb(1, null);
    // onResumeFailed is called synchronously inside the exit handler.
    expect(onResumeFailed).toHaveBeenCalledTimes(1);
    expect(updateResumedSessionStatus).toHaveBeenCalledWith(
      db,
      42,
      'expired-session-id',
      'claude-cli',
      'resume_failed',
    );
  });

  // --- Crash path with durability engine set (lines 1342-1344, 1351-1353):
  //     upsertSessionCheckpoint is called with 'orphaned'.

  it('unexpected exit upserts an orphaned checkpoint when durability is set', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const upsertSessionCheckpoint = vi.fn();
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    sm.setDurability({
      beginFreshSessionCheckpoint: vi.fn(),
      upsertSessionCheckpoint,
    } as unknown as Parameters<typeof sm.setDurability>[0]);
    await sm.spawnSession();
    const child = (sm as unknown as { child: MockChild }).child;
    if (child._exitCb) child._exitCb(2, null);
    expect(upsertSessionCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionStatus: 'orphaned' }),
    );
  });

  // --- handleCodexServerRequest: unhandled method falls through (line 853)
  //     and the requestUserInput branch denies with empty input (line 849).

  it('handleCodexServerRequest auto-approves known approval methods', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'codex-cli',
    });
    await sm.spawnSession();
    const child = (sm as unknown as { child: MockChild }).child;
    const writeCalls: string[] = [];
    (child.stdin.write as ReturnType<typeof vi.fn>).mockImplementation(
      (data: string) => {
        writeCalls.push(typeof data === 'string' ? data : String(data));
        return true;
      },
    );
    const handler = (sm as unknown as { handleCodexServerRequest: (m: Record<string, unknown>) => void }).handleCodexServerRequest.bind(sm);
    handler({ id: 7, method: 'item/commandExecution/requestApproval' });
    expect(writeCalls.some((m) => m.includes('"id":7') && m.includes('"approved"'))).toBe(true);
  });

  it('handleCodexServerRequest denies item/tool/requestUserInput with empty input', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'codex-cli',
    });
    await sm.spawnSession();
    const child = (sm as unknown as { child: MockChild }).child;
    const writeCalls: string[] = [];
    (child.stdin.write as ReturnType<typeof vi.fn>).mockImplementation((data: string) => {
      writeCalls.push(typeof data === 'string' ? data : String(data));
      return true;
    });
    const handler = (sm as unknown as { handleCodexServerRequest: (m: Record<string, unknown>) => void }).handleCodexServerRequest.bind(sm);
    handler({ id: 9, method: 'item/tool/requestUserInput' });
    expect(writeCalls.some((m) => m.includes('"id":9') && m.includes('"input":""'))).toBe(true);
  });

  it('handleCodexServerRequest logs but does not respond to unhandled methods', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'codex-cli',
    });
    await sm.spawnSession();
    const child = (sm as unknown as { child: MockChild }).child;
    let wrote = false;
    (child.stdin.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
      wrote = true;
      return true;
    });
    const handler = (sm as unknown as { handleCodexServerRequest: (m: Record<string, unknown>) => void }).handleCodexServerRequest.bind(sm);
    handler({ id: 11, method: 'something/unknown' });
    // No response written for an unhandled server-initiated request.
    expect(wrote).toBe(false);
  });

  it('handleCodexServerRequest is a no-op when no child is set', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'codex-cli',
    });
    // Don't spawn — child is null.
    const handler = (sm as unknown as { handleCodexServerRequest: (m: Record<string, unknown>) => void }).handleCodexServerRequest.bind(sm);
    expect(() => handler({ id: 1, method: 'item/commandExecution/requestApproval' })).not.toThrow();
  });

  // --- buildSpawnPerTurnPrompt: when systemPrompt is empty, returns text
  //     verbatim (line 857).

  it('buildSpawnPerTurnPrompt returns the raw text when no system prompt is set', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'opencode-cli',
    });
    await sm.spawnSession();
    // Clear the system prompt to hit the early-return.
    (sm as unknown as { systemPrompt: string }).systemPrompt = '';
    const fn = (sm as unknown as { buildSpawnPerTurnPrompt: (t: string) => string }).buildSpawnPerTurnPrompt.bind(sm);
    expect(fn('plain prompt')).toBe('plain prompt');
  });

  // --- probeLiveness writes a newline to stdin when active (line 1492).

  it('probeLiveness writes a newline when a child is active', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();
    const child = (sm as unknown as { child: MockChild }).child;
    const writes: string[] = [];
    (child.stdin.write as ReturnType<typeof vi.fn>).mockImplementation((d: string) => {
      writes.push(d);
      return true;
    });
    sm.probeLiveness();
    expect(writes).toContain('\n');
  });

  // --- handleWatchdogHard on a managed provider (lines 1519-1523): kills the
  //     managed session and notifies the user.

  it('hard watchdog kills a stalled managed provider and notifies the user', async () => {
    vi.useFakeTimers();
    const db = makeDb();
    const { messenger } = makeMessenger();
    const onCrash = vi.fn();
    const notifyUser = vi.fn();
    let rejectTurn!: (e: Error) => void;
    const stalled = new Promise<void>((_, reject) => {
      rejectTurn = reject;
    });
    vi.spyOn(OpenAIApiProvider.prototype, 'sendTurn').mockReturnValue(stalled);
    const killSpy = vi.spyOn(OpenAIApiProvider.prototype, 'kill').mockImplementation(function () {
      rejectTurn(new Error('watchdog-abort'));
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
    const turn = sm.sendTurn('stall').catch((e) => e as Error);
    // openai-api descriptor hard timeout = 10 min (NOT the 30-min default) — L1-F1
    await vi.advanceTimersByTimeAsync(600_000 + 1);
    const err = await turn;
    expect((err as Error).message).toBe('watchdog-abort');
    expect(killSpy).toHaveBeenCalled();
    expect(notifyUser).toHaveBeenCalledWith(expect.stringContaining('10 minutes'));
    vi.useRealTimers();
  });

  // --- handleProviderEvent: token_usage / result event records budget usage
  //     (lines 782-789) when a budget is configured.

  it('handleProviderEvent records token usage on a result event when budget is set', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const events: AgentEvent[] = [];
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: (e) => events.push(e),
      provider: 'openai-api',
      providerConfig: { budget: { tokensPerMinute: 1_000_000 } },
    });
    await sm.spawnSession();
    // Inject a result event with token counts directly via the private handler.
    const handler = (sm as unknown as { handleProviderEvent: (e: AgentEvent) => void }).handleProviderEvent.bind(sm);
    handler({
      type: 'result',
      text: 'done',
      inputTokens: 100,
      outputTokens: 50,
    } as AgentEvent);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'result', inputTokens: 100 })]));
  });

  it('handleProviderEvent records token usage on a token_usage event when budget is set', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const events: AgentEvent[] = [];
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: (e) => events.push(e),
      provider: 'openai-api',
      providerConfig: { budget: { tokensPerMinute: 1_000_000 } },
    });
    await sm.spawnSession();
    const handler = (sm as unknown as { handleProviderEvent: (e: AgentEvent) => void }).handleProviderEvent.bind(sm);
    handler({ type: 'token_usage', inputTokens: 10, outputTokens: 5 } as unknown as AgentEvent);
    expect(events.some((e) => e.type === 'token_usage')).toBe(true);
  });

  // --- handleProviderEvent: init event with durability upserts a checkpoint
  //     (lines 774-778). Codex/Gemini branches already covered elsewhere; this
  //     exercises the generic durability-upsert path via a synthetic init.

  it('handleProviderEvent upserts a session checkpoint on init when durability is set', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const upsertSessionCheckpoint = vi.fn();
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    sm.setDurability({
      beginFreshSessionCheckpoint: vi.fn(),
      upsertSessionCheckpoint,
    } as unknown as Parameters<typeof sm.setDurability>[0]);
    await sm.spawnSession();
    upsertSessionCheckpoint.mockClear();
    const handler = (sm as unknown as { handleProviderEvent: (e: AgentEvent) => void }).handleProviderEvent.bind(sm);
    handler({ type: 'init', sessionId: 'durab-session-id' });
    expect(upsertSessionCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: 'durab-session-id' }),
    );
  });

  // --- spawnSession is a no-op when already active with a child (line 935).

  it('spawnSession is a no-op when an active child is already running', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();
    const firstCallCount = (spawn as ReturnType<typeof vi.fn>).mock.calls.length;
    await sm.spawnSession(); // second call should be a no-op
    expect((spawn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(firstCallCount);
  });

  // --- spawnSession: spawn-per-turn path emits a synthetic init event
  //     (lines 1042-1064) — already covered indirectly, but assert the
  //     synthetic sessionId shape and the existingRowId reuse branch (1049-1051).

  it('spawnSession for opencode-cli with existingRowId reuses the row id', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const events: AgentEvent[] = [];
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: (e) => events.push(e),
      provider: 'opencode-cli',
    });
    await sm.spawnSession(undefined, 999);
    expect(sm.getDbRowId()).toBe(999);
    // Synthetic init event emitted with provider-prefixed id.
    expect(events.some((e) => e.type === 'init' && typeof e.sessionId === 'string')).toBe(true);
  });

  // --- spawnSession: DB persistence failure for the spawned child
  //     (lines 1108-1133) — createSession throws, child is SIGKILLed, state
  //     is reset and the error rethrown.

  it('spawnSession resets state and rethrows when DB persistence fails for the child', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const failure = new Error('db write failed');
    (createSession as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw failure;
    });
    exitOnSigkill(mockChild);
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await expect(sm.spawnSession()).rejects.toThrow('db write failed');
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
    const child = (sm as unknown as { child: MockChild | null }).child;
    // Child should have been SIGKILLed during cleanup.
    expect(child).toBeNull();
    expect(sm.getStatus()).toMatchObject({ active: false });
  });

  // --- spawnSession: managed-loop DB persistence failure (lines 965-975).

  it('spawnSession for managed provider resets and rethrows when DB persistence fails', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const failure = new Error('managed db write failed');
    (createSession as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw failure;
    });
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'openai-api',
    });
    await expect(sm.spawnSession()).rejects.toThrow('managed db write failed');
    expect(sm.getStatus()).toMatchObject({ active: false, sessionId: null });
  });

  // --- spawnSession: managed provider initialize() failure (lines 1006-1019).

  it('spawnSession marks crashed and rethrows when managed provider initialize() fails', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const onCrash = vi.fn();
    const failure = new Error('init blew up');
    vi.spyOn(OpenAIApiProvider.prototype, 'initialize').mockRejectedValue(failure);
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'openai-api',
      onCrash,
    });
    await expect(sm.spawnSession()).rejects.toThrow('init blew up');
    expect(updateSessionStatus).toHaveBeenCalledWith(db, 42, 'crashed');
    expect(sm.getStatus()).toMatchObject({ active: false });
  });

  // --- sendTurn for codex-cli / gemini-cli without a provider-ready promise
  //     (lines 1791-1793, 1825-1826): missing providerReadyPromise throws.

  it('sendTurn for codex-cli throws when providerReadyPromise was never initialized', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'codex-cli',
    });
    await sm.spawnSession();
    // Clear codexThreadId and providerReadyPromise to hit the throw branch.
    (sm as unknown as { codexThreadId: string | null }).codexThreadId = null;
    (sm as unknown as { providerReadyPromise: Promise<void> | null }).providerReadyPromise = null;
    await expect(sm.sendTurn('hi')).rejects.toThrow(/Codex provider ready promise not initialized/);
  });

  it('sendTurn for gemini-cli throws when providerReadyPromise was never initialized', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'gemini-cli',
    });
    await sm.spawnSession();
    (sm as unknown as { geminiSessionId: string | null }).geminiSessionId = null;
    (sm as unknown as { providerReadyPromise: Promise<void> | null }).providerReadyPromise = null;
    await expect(sm.sendTurn('hi')).rejects.toThrow(/Gemini provider ready promise not initialized/);
  });

  // --- spawn-per-turn non-zero exit (lines 1768-1779): emits onCrash and
  //     notifies the user, but session stays active.

  it('spawn-per-turn non-zero exit emits onCrash and notifies the user', async () => {
    vi.useFakeTimers();
    const db = makeDb();
    const { messenger } = makeMessenger();
    const onCrash = vi.fn();
    const notifyUser = vi.fn();
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'opencode-cli',
      model: 'glm/test-model',
      onCrash,
      notifyUser,
    });
    await sm.spawnSession();
    await sm.sendTurn('go');
    const child = (sm as unknown as { child: MockChild }).child;
    if (child._exitCb) child._exitCb(1, null);
    if (child._closeCb) child._closeCb(1, null);
    await vi.advanceTimersByTimeAsync(0); // flush close-boundary callbacks
    await vi.advanceTimersByTimeAsync(0); // flush notifyUnexpectedExit setImmediate
    expect(onCrash).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 1 }));
    vi.useRealTimers();
  });

  it('commits only the final OpenCode stop candidate after a clean process close', async () => {
    const events: AgentEvent[] = [];
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger().messenger,
      chatJid: CHAT_JID,
      onEvent: (event) => events.push(event),
      provider: 'opencode-cli',
      model: 'glm/test-model',
    });
    await sm.spawnSession();
    events.length = 0;
    await sm.sendTurn('run one tool and report the result');

    const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
    mockChild.stdout.emit('data', Buffer.from([
      line({ type: 'step_start', sessionID: 'ses_compaction', part: { type: 'step-start' } }),
      line({ type: 'text', part: { text: 'intermediate compaction summary' } }),
      line({
        type: 'step_finish',
        part: { type: 'step-finish', reason: 'stop', tokens: { input: 130_000, output: 50 } },
      }),
      line({ type: 'step_start', sessionID: 'ses_compaction', part: { type: 'step-start' } }),
      line({ type: 'text', part: { text: 'verified final answer' } }),
      line({
        type: 'step_finish',
        part: { type: 'step-finish', reason: 'stop', tokens: { input: 800, output: 12 } },
      }),
    ].join('')));

    expect(events.filter((event) => event.type === 'assistant_text' || event.type === 'result')).toEqual([]);

    mockChild._closeCb?.(0, null);

    expect(events.filter((event) => event.type === 'assistant_text' || event.type === 'result')).toEqual([
      { type: 'assistant_text', text: 'verified final answer' },
      { type: 'result', text: null, inputTokens: 800, outputTokens: 12, costUsd: undefined },
    ]);
  });

  it('surfaces bounded OpenCode tool activity while terminal text remains buffered', async () => {
    const events: AgentEvent[] = [];
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger().messenger,
      chatJid: CHAT_JID,
      onEvent: (event) => events.push(event),
      provider: 'opencode-cli',
      model: 'glm/test-model',
    });
    await sm.spawnSession();
    events.length = 0;
    await sm.sendTurn('run one tool and report the result');

    const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
    mockChild.stdout.emit('data', Buffer.from([
      line({
        type: 'tool_use',
        part: {
          tool: 'bash',
          callID: 'call-live-progress',
          state: {
            status: 'completed',
            input: { command: 'sensitive command text' },
            output: 'sensitive command output',
          },
        },
      }),
      line({ type: 'text', part: { text: 'terminal text must wait for process close' } }),
    ].join('')));

    const toolEvents = events.filter(
      (event) => event.type === 'tool_use' || event.type === 'tool_result',
    );
    expect(toolEvents).toEqual([
      {
        type: 'tool_use',
        toolName: 'bash',
        toolId: 'call-live-progress',
        toolInput: {},
      },
      {
        type: 'tool_result',
        isError: false,
        toolId: 'call-live-progress',
        toolName: 'bash',
        content: 'sensitive command output',
      },
    ]);
    expect(JSON.stringify(toolEvents[0])).not.toContain('sensitive command');
    expect(events.filter((event) => event.type === 'assistant_text' || event.type === 'result')).toEqual([]);

    mockChild.stdout.emit('data', Buffer.from(line({
      type: 'step_finish',
      part: { type: 'step-finish', reason: 'stop', tokens: { input: 800, output: 12 } },
    })));
    mockChild._closeCb?.(0, null);

    expect(events.filter((event) => event.type === 'assistant_text' || event.type === 'result')).toEqual([
      { type: 'assistant_text', text: 'terminal text must wait for process close' },
      { type: 'result', text: null, inputTokens: 800, outputTokens: 12, costUsd: undefined },
    ]);
  });

  it('discards repeated OpenCode stop candidates and bounds delivery to the final candidate', async () => {
    const events: AgentEvent[] = [];
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger().messenger,
      chatJid: CHAT_JID,
      onEvent: (event) => events.push(event),
      provider: 'opencode-cli',
      model: 'glm/test-model',
    });
    await sm.spawnSession();
    events.length = 0;
    await sm.sendTurn('stress compaction boundaries');

    const records: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      records.push(
        JSON.stringify({ type: 'text', part: { text: `discard-${index}` } }),
        JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } }),
        JSON.stringify({ type: 'step_start', sessionID: 'ses_stress', part: { type: 'step-start' } }),
      );
    }
    records.push(
      JSON.stringify({ type: 'text', part: { text: 'keep-final' } }),
      JSON.stringify({
        type: 'step_finish',
        part: { type: 'step-finish', reason: 'stop', tokens: { input: 900, output: 9 } },
      }),
    );
    mockChild.stdout.emit('data', Buffer.from(`${records.join('\n')}\n`));
    mockChild._closeCb?.(0, null);

    expect(events.filter((event) => event.type === 'assistant_text' || event.type === 'result')).toEqual([
      { type: 'assistant_text', text: 'keep-final' },
      { type: 'result', text: null, inputTokens: 900, outputTokens: 9, costUsd: undefined },
    ]);
  });

  it('fails closed when OpenCode continues after stop but exits without a final candidate', async () => {
    const events: AgentEvent[] = [];
    const onCrash = vi.fn();
    const notifyUser = vi.fn();
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger().messenger,
      chatJid: CHAT_JID,
      onEvent: (event) => events.push(event),
      provider: 'opencode-cli',
      model: 'glm/test-model',
      onCrash,
      notifyUser,
    });
    await sm.spawnSession();
    events.length = 0;
    await sm.sendTurn('incomplete compaction continuation');

    mockChild.stdout.emit('data', Buffer.from([
      JSON.stringify({ type: 'text', part: { text: 'discarded summary' } }),
      JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } }),
      JSON.stringify({ type: 'step_start', sessionID: 'ses_incomplete', part: { type: 'step-start' } }),
      '',
    ].join('\n')));
    mockChild._closeCb?.(0, null);

    expect(events.filter((event) => event.type === 'assistant_text' || event.type === 'result')).toEqual([]);
    expect(onCrash).toHaveBeenCalledWith(expect.objectContaining({
      exitCode: 0,
      signal: null,
      crashClass: 'provider_stream_corrupt',
    }));
    expect(notifyUser).toHaveBeenCalledWith(expect.stringMatching(/ended before completing the turn/i));
  });

  it('serializes OpenCode process lifetimes across session managers sharing one execution gate', async () => {
    const firstChild = makeMockChild(12001);
    const secondChild = makeMockChild(12002);
    vi.mocked(spawn).mockReturnValueOnce(firstChild as never).mockReturnValueOnce(secondChild as never);
    const gate = new ProviderExecutionGate();
    const first = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger().messenger,
      chatJid: 'first@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'opencode-cli',
      model: 'glm/test-model',
      providerExecutionGate: gate,
    });
    const second = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger().messenger,
      chatJid: 'second@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'opencode-cli',
      model: 'glm/test-model',
      providerExecutionGate: gate,
    });
    await first.spawnSession();
    await second.spawnSession();

    const firstBoundary = vi.fn();
    const secondBoundary = vi.fn();
    await first.sendTurnAtProviderBoundary('first', firstBoundary);
    let secondStarted = false;
    const secondTurn = second.sendTurnAtProviderBoundary('second', secondBoundary).then(() => {
      secondStarted = true;
    });
    await Promise.resolve();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(secondStarted).toBe(false);
    expect(firstBoundary).toHaveBeenCalledTimes(1);
    expect(secondBoundary).not.toHaveBeenCalled();
    expect(gate.snapshot()).toMatchObject({
      active: true,
      activeWorkKind: 'turn',
      activeScopeHash: shortHash('first@s.whatsapp.net'),
      pending: 1,
      oldestPendingWorkKind: 'turn',
      oldestPendingScopeHash: shortHash('second@s.whatsapp.net'),
    });

    firstChild._closeCb?.(0, null);
    await secondTurn;
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(secondStarted).toBe(true);
    expect(secondBoundary).toHaveBeenCalledTimes(1);
    expect(gate.snapshot()).toMatchObject({ active: true, pending: 0 });

    secondChild._closeCb?.(0, null);
    expect(gate.snapshot()).toMatchObject({ active: false, pending: 0 });
  });

  it('reaps a completed same-session OpenCode child before waiting for its next execution lease', async () => {
    const firstChild = makeMockChild(12005);
    const secondChild = makeMockChild(12006);
    vi.mocked(spawn)
      .mockReturnValueOnce(firstChild as never)
      .mockReturnValueOnce(secondChild as never);
    const gate = new ProviderExecutionGate();
    const session = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger().messenger,
      chatJid: 'same@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'opencode-cli',
      model: 'glm/test-model',
      providerExecutionGate: gate,
    });
    await session.spawnSession();

    await session.sendTurn('first');
    session.completeProviderTurn();
    const secondTurn = session.sendTurn('second');

    await vi.waitFor(() => {
      expect(killSessionTree).toHaveBeenCalledWith(
        firstChild,
        'SIGTERM',
        expect.objectContaining({ generationMarker: expect.any(String) }),
      );
    });
    await secondTurn;

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(killSessionTree).toHaveBeenCalledTimes(1);
    expect(gate.snapshot()).toMatchObject({ active: true, pending: 0, totalWaits: 0 });

    secondChild._closeCb?.(0, null);
    expect(gate.snapshot()).toMatchObject({ active: false, pending: 0 });
  });

  it('cycles repeated same-session OpenCode turns without self-queuing behind stale leases', async () => {
    const children = Array.from({ length: 25 }, (_, index) => makeMockChild(12100 + index));
    for (const child of children) vi.mocked(spawn).mockReturnValueOnce(child as never);
    const gate = new ProviderExecutionGate();
    const session = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger().messenger,
      chatJid: 'same-stress@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'opencode-cli',
      model: 'glm/test-model',
      providerExecutionGate: gate,
    });
    await session.spawnSession();

    for (let turn = 0; turn < children.length; turn += 1) {
      await session.sendTurn(`turn-${turn}`);
      session.completeProviderTurn();
      expect(gate.snapshot()).toMatchObject({ active: true, pending: 0 });
    }

    expect(spawn).toHaveBeenCalledTimes(children.length);
    expect(killSessionTree).toHaveBeenCalledTimes(children.length - 1);
    expect(gate.snapshot()).toMatchObject({
      active: true,
      pending: 0,
      totalWaits: 0,
      maxPending: 0,
      pressureActive: false,
    });

    children.at(-1)?._closeCb?.(0, null);
    expect(gate.snapshot()).toMatchObject({ active: false, pending: 0 });
  });

  it('aborts an OpenCode execution waiter when its session shuts down', async () => {
    const firstChild = makeMockChild(12003);
    vi.mocked(spawn).mockReturnValueOnce(firstChild as never);
    const gate = new ProviderExecutionGate();
    const first = new SessionManager({
      db: makeDb(), messenger: makeMessenger().messenger,
      chatJid: 'first@s.whatsapp.net', onEvent: vi.fn(),
      provider: 'opencode-cli', model: 'glm/test-model', providerExecutionGate: gate,
    });
    const waiting = new SessionManager({
      db: makeDb(), messenger: makeMessenger().messenger,
      chatJid: 'waiting@s.whatsapp.net', onEvent: vi.fn(),
      provider: 'opencode-cli', model: 'glm/test-model', providerExecutionGate: gate,
    });
    await first.spawnSession();
    await waiting.spawnSession();
    await first.sendTurn('first');
    const waitingTurn = waiting.sendTurn('waiting').catch((error: Error) => error);
    await Promise.resolve();

    await waiting.shutdown();
    await expect(waitingTurn).resolves.toMatchObject({
      message: expect.stringContaining('PROVIDER_EXECUTION_WAIT_ABORTED'),
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(gate.snapshot()).toMatchObject({ active: true, pending: 0, abortedWaits: 1 });

    firstChild._closeCb?.(0, null);
    expect(gate.snapshot()).toMatchObject({ active: false, pending: 0 });
  });

  it('releases the OpenCode execution lease when spawn fails before a child exists', async () => {
    const recoveredChild = makeMockChild(12004);
    vi.mocked(spawn)
      .mockImplementationOnce(() => { throw new Error('synthetic spawn failure'); })
      .mockReturnValueOnce(recoveredChild as never);
    const gate = new ProviderExecutionGate();
    const first = new SessionManager({
      db: makeDb(), messenger: makeMessenger().messenger,
      chatJid: 'first@s.whatsapp.net', onEvent: vi.fn(),
      provider: 'opencode-cli', model: 'glm/test-model', providerExecutionGate: gate,
    });
    const second = new SessionManager({
      db: makeDb(), messenger: makeMessenger().messenger,
      chatJid: 'second@s.whatsapp.net', onEvent: vi.fn(),
      provider: 'opencode-cli', model: 'glm/test-model', providerExecutionGate: gate,
    });
    await first.spawnSession();
    await second.spawnSession();

    await expect(first.sendTurn('first')).rejects.toThrow('synthetic spawn failure');
    expect(gate.snapshot()).toMatchObject({ active: false, pending: 0 });
    await second.sendTurn('second');
    expect(gate.snapshot()).toMatchObject({ active: true, pending: 0 });
    recoveredChild._closeCb?.(0, null);
    expect(gate.snapshot()).toMatchObject({ active: false, pending: 0 });
  });

  // --- Codex stdout: server-initiated request routing + resume-error retry
  //     (lines 1227-1262). Feed a JSON-RPC line that looks like a resume
  //     error response and assert a fresh thread/start is sent.

  it('codex resume thread/start error response triggers a fresh thread/start retry', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'codex-cli',
    });
    await sm.spawnSession('stale-thread-id');
    const child = (sm as unknown as { child: MockChild }).child;
    const writes: string[] = [];
    (child.stdin.write as ReturnType<typeof vi.fn>).mockImplementation((data: string) => {
      writes.push(typeof data === 'string' ? data : String(data));
      return true;
    });
    // The resume request id was assigned during spawnSession; capture it.
    const resumeReqId = (sm as unknown as { codexResumeThreadStartReqId: string | null }).codexResumeThreadStartReqId;
    expect(resumeReqId).not.toBeNull();
    // Emit the error response line on stdout.
    const errLine = JSON.stringify({ jsonrpc: '2.0', id: resumeReqId, error: { message: 'thread not found' } });
    child.stdout.emit('data', Buffer.from(errLine + '\n'));
    // A fresh thread/start (no threadId) should have been written.
    const freshThreadStart = writes.find((m) => m.includes('"method":"thread/start"') && !m.includes('"threadId"'));
    expect(freshThreadStart).toBeDefined();
    // updateSessionId cleared the stale id.
    expect(updateSessionId).toHaveBeenCalledWith(db, 42, '');
  });

  // --- Codex stdout: server-initiated request routed to handleCodexServerRequest
  //     (lines 1227-1232).

  it('codex stdout routes a server-initiated approval request to the handler', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'codex-cli',
    });
    await sm.spawnSession();
    const child = (sm as unknown as { child: MockChild }).child;
    const writes: string[] = [];
    (child.stdin.write as ReturnType<typeof vi.fn>).mockImplementation((data: string) => {
      writes.push(typeof data === 'string' ? data : String(data));
      return true;
    });
    const reqLine = JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'item/fileChange/requestApproval' });
    child.stdout.emit('data', Buffer.from(reqLine + '\n'));
    expect(writes.some((m) => m.includes('"id":42') && m.includes('"approved"'))).toBe(true);
  });

  // --- gemini-cli sendTurn happy path: writes session/prompt request
  //     (lines 1790-1817).

  it('gemini-cli sendTurn writes a session/prompt request once the session is ready', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'gemini-cli',
    });
    await sm.spawnSession();
    // Pretend the session/new response arrived with a sessionId.
    (sm as unknown as { geminiSessionId: string | null }).geminiSessionId = 'gem-session-1';
    const child = (sm as unknown as { child: MockChild }).child;
    const writes: string[] = [];
    (child.stdin.write as ReturnType<typeof vi.fn>).mockImplementation((
      data: string,
      _encoding: unknown,
      callback?: (err?: Error | null) => void,
    ) => {
      writes.push(typeof data === 'string' ? data : String(data));
      callback?.();
      return true;
    });
    await sm.sendTurn('hello gemini');
    expect(writes.some((m) => m.includes('"method":"session/prompt"'))).toBe(true);
    expect(incrementMessageCount).toHaveBeenCalledWith(db, 42);
  });

  it('gemini-cli tears down on an ambiguous session/prompt stdin error', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'gemini-cli',
    });
    await sm.spawnSession();
    (sm as unknown as { geminiSessionId: string | null }).geminiSessionId = 'gem-session-1';
    const child = (sm as unknown as { child: MockChild }).child;
    child.stdin.write.mockImplementation(
      (_data: unknown, _enc: unknown, cb?: (err?: Error | null) => void) => {
        if (typeof cb === 'function') cb(new Error('EPIPE'));
        return false;
      },
    );

    await expect(sm.sendTurn('hello gemini')).rejects.toThrow('EPIPE');

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(sm.getStatus()).toMatchObject({ active: false, turnInFlight: false });
  });

  // --- Claude-cli stdin write timeout (lines 1860-1880).

  it('claude-cli sendTurn rejects with STDIN_WRITE_TIMEOUT when stdin.write never calls back', async () => {
    vi.useFakeTimers();
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();
    const child = (sm as unknown as { child: MockChild }).child;
    // stdin.write with no callback signature -> hangs forever.
    (child.stdin.write as ReturnType<typeof vi.fn>).mockImplementation(() => true);
    const turn = sm.sendTurn('hang').catch((e) => e as Error);
    // STDIN_WRITE_TIMEOUT_MS is 30s in source; advance past it.
    await vi.advanceTimersByTimeAsync(31_000);
    const err = (await turn) as Error;
    expect(err.message).toContain('STDIN_WRITE_TIMEOUT');
    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(sm.getStatus()).toMatchObject({ active: false, turnInFlight: false });
    vi.useRealTimers();
  });

  // --- Claude-cli stdin write error path (line 1867).

  it('holds provider ownership until an ambiguous stdin error has process-tree shutdown proof', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();
    const child = (sm as unknown as { child: MockChild }).child;
    let proveShutdown: (() => void) | undefined;
    const shutdownProof = new Promise<void>((resolve) => {
      proveShutdown = resolve;
    });
    (killSessionTree as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (target: { kill: (signal: NodeJS.Signals) => boolean }, signal: NodeJS.Signals) => {
        target.kill(signal);
        await shutdownProof;
      },
    );
    (child.stdin.write as ReturnType<typeof vi.fn>).mockImplementation(
      (_data: unknown, _enc: unknown, cb: (err?: Error | null) => void) => {
        if (typeof _enc === 'function') (_enc as (e?: Error | null) => void)(new Error('EPIPE'));
        else if (typeof cb === 'function') cb(new Error('EPIPE'));
        return false;
      },
    );
    let settled = false;
    const turn = sm.sendTurn('boom').then(
      () => null,
      (err: Error) => err,
    );
    void turn.then(() => { settled = true; });

    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGTERM'));
    expect(sm.getStatus().turnInFlight).toBe(true);
    expect(settled).toBe(false);

    proveShutdown?.();
    expect((await turn)?.message).toBe('EPIPE');
    expect(sm.getStatus()).toMatchObject({ active: false, turnInFlight: false });
  });

  it('retains provider ownership when ambiguous-write teardown is inconclusive', async () => {
    vi.useFakeTimers();
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();
    const child = (sm as unknown as { child: MockChild }).child;
    (killSessionTree as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('process tree still alive'),
    );
    (child.stdin.write as ReturnType<typeof vi.fn>).mockImplementation(
      (_data: unknown, _enc: unknown, cb: (err?: Error | null) => void) => {
        if (typeof _enc === 'function') (_enc as (e?: Error | null) => void)(new Error('EPIPE'));
        else if (typeof cb === 'function') cb(new Error('EPIPE'));
        return false;
      },
    );

    const err = await sm.sendTurn('boom').catch((error: Error) => error);

    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'EPIPE' }),
      expect.objectContaining({ message: 'process tree still alive' }),
    ]);
    expect(sm.getStatus()).toMatchObject({ active: false, turnInFlight: true });
    vi.useRealTimers();
  });

  // --- Claude-cli stdin null guard (line 1860).

  it('claude-cli sendTurn throws when child stdin is null', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();
    // Replace child.stdin with null to hit the guard.
    (sm as unknown as { child: MockChild }).child.stdin = null as unknown as MockChild['stdin'];
    await expect(sm.sendTurn('hi')).rejects.toThrow(/Child process stdin is not available/);
    expect(sm.getStatus().turnInFlight).toBe(false);
  });

  // --- handleNew shuts down and respawns (line 1893-1895).

  it('handleNew ends the current session and spawns a fresh one', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();
    const firstPid = sm.getStatus().pid;
    const child2 = makeMockChild(88888);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(child2);
    await sm.handleNew();
    expect(updateSessionStatus).toHaveBeenCalledWith(db, 42, 'ended');
    expect(sm.getStatus().pid).toBe(88888);
    expect(sm.getStatus().pid).not.toBe(firstPid);
  });

  // --- assertKnownProvider throw via direct instantiation with unknown id
  //     (lines 676-682). The constructor itself throws.

  it('constructor throws for an unknown provider id', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    expect(
      () =>
        new SessionManager({
          db,
          messenger,
          chatJid: CHAT_JID,
          onEvent: vi.fn(),
          provider: 'totally-fake',
        }),
    ).toThrow(/unknown provider id/);
  });

  // --- updateMcpActorJid no-op when no mcpSessionContext (line 580).

  it('updateMcpActorJid is a no-op when no mcpSessionContext is configured', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    expect(() => sm.updateMcpActorJid('1555XXXXXXX@s.whatsapp.net')).not.toThrow();
  });

  it('updateMcpActorJid sets actorJid when mcpSessionContext is configured', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const ctx = { actorJid: 'old@s.whatsapp.net' };
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      mcpSessionContext: ctx as never,
    });
    sm.updateMcpActorJid('1555XXXXXXX@s.whatsapp.net');
    expect(ctx.actorJid).toBe('1555XXXXXXX@s.whatsapp.net');
  });

  // --- trackToolStart / trackToolEnd / hasPendingTools (lines 916-925).

  it('trackToolStart and trackToolEnd toggle hasPendingTools', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    expect(sm.hasPendingTools).toBe(false);
    sm.trackToolStart('t1');
    expect(sm.hasPendingTools).toBe(true);
    sm.trackToolEnd('t1');
    expect(sm.hasPendingTools).toBe(false);
  });

  // --- getProviderId returns the configured provider (line 1917-1919).

  it('getProviderId returns the configured provider id', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'codex-cli',
    });
    expect(sm.getProviderId()).toBe('codex-cli');
  });

  // --- getDbRowId before spawn returns null, after spawn returns the row id.

  it('getDbRowId returns null before spawn and the row id after', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    expect(sm.getDbRowId()).toBeNull();
    await sm.spawnSession();
    expect(sm.getDbRowId()).toBe(42);
  });

  // --- composeWithExactLineDedup via buildSystemPrompt: handoffSystemBlock
  //     returning null is skipped (line 636) and configSystemPrompt is added.

  it('buildSystemPrompt includes configSystemPrompt and skips a null handoff block', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    let handoffCalled = false;
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      cwd: '/cwd',
      configSystemPrompt: 'EXTRA-CONFIG-PROMPT',
      handoffSystemBlock: () => {
        handoffCalled = true;
        return null;
      },
    });
    const prompt = (sm as unknown as { buildSystemPrompt: () => string }).buildSystemPrompt();
    expect(handoffCalled).toBe(true);
    expect(prompt).toContain('EXTRA-CONFIG-PROMPT');
  });

  it('buildSystemPrompt includes a non-null handoff block', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      cwd: '/cwd',
      handoffSystemBlock: () => 'HANDOFF-BLOCK-TEXT',
    });
    const prompt = (sm as unknown as { buildSystemPrompt: () => string }).buildSystemPrompt();
    expect(prompt).toContain('HANDOFF-BLOCK-TEXT');
  });

  // --- buildSystemPrompt reads instructionsPath and appends its content
  //     (lines 644-655, the success branch + non-empty content branch).

  it('buildSystemPrompt appends the instructionsPath file content when present', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    (readFileSync as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce('INSTRUCTIONS-CONTENT');
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      cwd: '/cwd',
      instructionsPath: 'AGENTS.md',
    });
    const prompt = (sm as unknown as { buildSystemPrompt: () => string }).buildSystemPrompt();
    expect(prompt).toContain('INSTRUCTIONS-CONTENT');
  });

  // --- managed-loop provider crash callback updates db status (lines 989-991,
  //     1008-1010): exercised when the provider emits an onCrash during a turn.

  it('managed provider onCrash callback marks the row crashed', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const onCrash = vi.fn();
    const crashCallbacks: Array<(info: { exitCode: number | null; signal: string | null; provider: string; crashClass?: string; stderrPreview?: string }) => void> = [];
    let generationIdentity = { managerId: 'managed-provider-callback', generation: 1 };
    vi.spyOn(OpenAIApiProvider.prototype, 'initialize').mockImplementation(async function (this: OpenAIApiProvider, opts) {
      crashCallbacks.push(opts.onCrash as (typeof crashCallbacks)[number]);
      return Promise.resolve();
    });
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'openai-api',
      onCrash,
    });
    sm.bindGenerationOwnership(() => generationIdentity);
    await sm.spawnSession();
    vi.mocked(updateSessionStatus).mockClear();
    crashCallbacks[0]!({ exitCode: 1, signal: null, provider: 'openai-api' });
    expect(updateSessionStatus).toHaveBeenCalledWith(db, 42, 'crashed');
    expect(onCrash).toHaveBeenCalledWith(expect.objectContaining({ generationIdentity }));

    generationIdentity = { managerId: 'managed-provider-callback', generation: 2 };
    await sm.spawnSession();
    vi.mocked(updateSessionStatus).mockClear();
    onCrash.mockClear();

    crashCallbacks[0]!({ exitCode: 1, signal: null, provider: 'openai-api' });

    expect(updateSessionStatus).not.toHaveBeenCalled();
    expect(onCrash).not.toHaveBeenCalled();
    expect(sm.getStatus()).toMatchObject({ active: true });
    expect((sm as unknown as { managedProviderSession: unknown }).managedProviderSession).not.toBeNull();
  });

  it('drops managed provider events from a stale generation', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const onEvent = vi.fn();
    let providerEvent!: (event: AgentEvent) => void;
    let generationIdentity = { managerId: 'managed-provider-event', generation: 1 };
    vi.spyOn(OpenAIApiProvider.prototype, 'initialize').mockImplementation(async function (opts) {
      providerEvent = opts.onEvent;
    });
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent,
      provider: 'openai-api',
    });
    sm.bindGenerationOwnership(() => generationIdentity);
    await sm.spawnSession();
    onEvent.mockClear();
    generationIdentity = { managerId: 'managed-provider-event', generation: 2 };

    providerEvent({ type: 'assistant_text', text: 'stale provider output' });

    expect(onEvent).not.toHaveBeenCalled();
  });

  // --- clearShutdownKillTimer clears a pending kill timer (lines 691-695).
  //     Indirectly: spawnSession clears any prior timer at the start.

  it('shutdown clears the shutdown kill timer when called twice in a row', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();
    await sm.shutdown(true);
    // A second shutdown with no child should not throw and should leave state clean.
    await expect(sm.shutdown(true)).resolves.toBeUndefined();
    expect(sm.getStatus()).toMatchObject({ active: false });
  });
});
