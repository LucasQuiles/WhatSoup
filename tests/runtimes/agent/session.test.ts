import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { SessionManager } from '../../../src/runtimes/agent/session.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';

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
  };
  (stdin as unknown as { write: ReturnType<typeof vi.fn> }).write = vi.fn(
    (_data: unknown, _enc?: unknown, cb?: (err?: Error | null) => void) => { if (typeof _enc === 'function') (_enc as (err?: Error | null) => void)(); else if (typeof cb === 'function') cb(); },
  );

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
import { formatAge, TURN_WATCHDOG_MS, WATCHDOG_SOFT_MS, WATCHDOG_WARN_MS, WATCHDOG_HARD_MS, PROVIDER_DISPLAY_NAMES } from '../../../src/runtimes/agent/session.ts';

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
  };
  return { messenger, sentMessages };
}

// ─── DB mock helpers ──────────────────────────────────────────────────────────

vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  createSession: vi.fn(() => 42),
  incrementMessageCount: vi.fn(),
  updateSessionId: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateTranscriptPath: vi.fn(),
}));

import {
  createSession,
  updateSessionId,
  updateSessionStatus,
} from '../../../src/runtimes/agent/session-db.ts';

const CHAT_JID = 'test@s.whatsapp.net';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SessionManager', () => {
  let mockChild: MockChild;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = makeMockChild(12345);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
  });

  afterEach(() => {
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
        '--system-prompt', expect.stringContaining('personal'),
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

    // Flush microtasks so the messenger.send promise resolves
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(updateSessionStatus).toHaveBeenCalledWith(db, 42, 'crashed');
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].jid).toBe(CHAT_JID);
    expect(sentMessages[0].text).toContain('session ended');
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

  it('spawnSession is a no-op if already active', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();
    await sm.spawnSession(); // second call

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('createSession is called with pid, cwd, and chatJid', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    await sm.spawnSession();

    expect(createSession).toHaveBeenCalledWith(db, 12345, '/mock/home', CHAT_JID);
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
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // Second crash — spawn fresh child, crash immediately
    const mockChild2 = makeMockChild(22222);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild2);
    await sm.spawnSession();
    mockChild2._exitCb?.(1, null);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // Third crash
    const mockChild3 = makeMockChild(33333);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild3);
    await sm.spawnSession();
    mockChild3._exitCb?.(1, null);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // Only the first crash should have sent a notification
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain('session ended');
  });

  // ─── P3-A: Watchdog tests ─────────────────────────────────────────────────

  it('sendTurn arms the 3-tier watchdog and SIGKILL fires after WATCHDOG_HARD_MS (30 min)', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), instanceName: 'personal', notifyUser });
    await sm.spawnSession();
    await sm.sendTurn('test message');

    // Nothing should fire before 10 min
    expect(mockChild.kill).not.toHaveBeenCalledWith('SIGKILL');
    expect(notifyUser).not.toHaveBeenCalled();

    // Advance to soft probe (10 min)
    await vi.advanceTimersByTimeAsync(WATCHDOG_SOFT_MS + 1);
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect(notifyUser.mock.calls[0][0]).toContain('10+ minutes');
    expect(mockChild.kill).not.toHaveBeenCalledWith('SIGKILL');

    // Advance to warn probe (20 min)
    await vi.advanceTimersByTimeAsync(WATCHDOG_WARN_MS - WATCHDOG_SOFT_MS);
    expect(notifyUser).toHaveBeenCalledTimes(2);
    expect(notifyUser.mock.calls[1][0]).toContain('20+ minutes');
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

    expect((sm as unknown as { watchdogSoft: unknown }).watchdogSoft).not.toBeNull();
    expect((sm as unknown as { watchdogWarn: unknown }).watchdogWarn).not.toBeNull();
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

  it('tickWatchdog resets all tiers — agent activity prevents kill', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), instanceName: 'personal', notifyUser });
    await sm.spawnSession();
    await sm.sendTurn('test message');

    // Advance to just before soft probe
    await vi.advanceTimersByTimeAsync(WATCHDOG_SOFT_MS - 1_000);
    expect(notifyUser).not.toHaveBeenCalled();

    // Simulate agent activity — resets all timers
    sm.tickWatchdog();

    // Advance another 9 minutes — no probe should fire (timer was reset)
    await vi.advanceTimersByTimeAsync(WATCHDOG_SOFT_MS - 1_000);
    expect(notifyUser).not.toHaveBeenCalled();
    expect(mockChild.kill).not.toHaveBeenCalledWith('SIGKILL');

    // Now advance past the reset soft threshold
    await vi.advanceTimersByTimeAsync(2_000);
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect(mockChild.kill).not.toHaveBeenCalledWith('SIGKILL');

    vi.useRealTimers();
  });

  it('tickWatchdog is a no-op when session is inactive', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn() });
    // No session spawned — tickWatchdog should not throw
    sm.tickWatchdog();

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

    // Flush microtasks
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

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
    const systemPromptIdx = args.indexOf('--system-prompt');
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
    const systemPromptIdx = args.indexOf('--system-prompt');
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

  it('system prompt uses provider string as fallback for unknown providers', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sm = new SessionManager({
      db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(),
      provider: 'custom-provider',
    });
    await sm.spawnSession();

    // Unknown providers are spawn-per-turn, so systemPrompt is stored on the instance
    expect((sm as unknown as { systemPrompt: string }).systemPrompt).toContain('a personal custom-provider agent');
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

  it('soft watchdog shows busy message when tools are pending', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), instanceName: 'personal', notifyUser });
    await sm.spawnSession();
    await sm.sendTurn('test message');

    sm.trackToolStart('long-tool-1');

    await vi.advanceTimersByTimeAsync(WATCHDOG_SOFT_MS + 1);
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect(notifyUser.mock.calls[0][0]).toContain('long operation');
    expect(notifyUser.mock.calls[0][0]).toContain('10+ min');

    vi.useRealTimers();
  });

  it('warn watchdog shows busy message when tools are pending', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), instanceName: 'personal', notifyUser });
    await sm.spawnSession();
    await sm.sendTurn('test message');

    sm.trackToolStart('long-tool-2');

    await vi.advanceTimersByTimeAsync(WATCHDOG_WARN_MS + 1);
    expect(notifyUser).toHaveBeenCalledTimes(2);
    // soft fires first (busy message)
    expect(notifyUser.mock.calls[0][0]).toContain('long operation');
    // warn fires second (busy message)
    expect(notifyUser.mock.calls[1][0]).toContain('20+ min');

    vi.useRealTimers();
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

  it('soft/warn watchdog shows idle message when no tools pending', async () => {
    vi.useFakeTimers();

    const db = makeDb();
    const { messenger } = makeMessenger();
    const notifyUser = vi.fn();

    const sm = new SessionManager({ db, messenger, chatJid: CHAT_JID, onEvent: vi.fn(), instanceName: 'personal', notifyUser });
    await sm.spawnSession();
    await sm.sendTurn('test message');

    // No pending tools — should show idle message
    await vi.advanceTimersByTimeAsync(WATCHDOG_SOFT_MS + 1);
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect(notifyUser.mock.calls[0][0]).toContain('without responding');

    await vi.advanceTimersByTimeAsync(WATCHDOG_WARN_MS - WATCHDOG_SOFT_MS);
    expect(notifyUser).toHaveBeenCalledTimes(2);
    expect(notifyUser.mock.calls[1][0]).toContain('silent for 20+ minutes');

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
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(sentMessages).toHaveLength(1);

    // Second crash at t=61s (past the 60s cooldown)
    vi.spyOn(Date, 'now').mockReturnValue(baseTime + 61_000);

    const mockChild2 = makeMockChild(22222);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild2);
    await sm.spawnSession();
    mockChild2._exitCb?.(1, null);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

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
      id: 'ws-2',
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
      id: 'ws-2',
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
    // The thread/start request was the second request (ws-2).
    const errorResponse = JSON.stringify({
      jsonrpc: '2.0',
      id: 'ws-2',
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
    expect(payload.params.threadId).toBeUndefined();
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
      id: 'ws-2',
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
    expect(payload.params.threadId).toBeUndefined();
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
