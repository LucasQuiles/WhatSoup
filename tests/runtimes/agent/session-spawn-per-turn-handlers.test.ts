// Net-new coverage for SessionManager spawn-per-turn child lifecycle handlers.
//
// INTENDED REPO PATH: tests/runtimes/agent/session-spawn-per-turn-handlers.test.ts
//   (new sibling file next to tests/runtimes/agent/session.test.ts — kept
//    separate because it needs a child mock that captures the 'error', 'exit',
//    and drained 'close' handlers independently.)
//
// TARGET UNCOVERED LINES in src/runtimes/agent/session.ts (sendTurn,
// spawn-per-turn / opencode-cli branch, ~lines 1606-1696):
//   1606-1631  child.on('error') handler:
//                ENOENT  -> notifyUser("<binary> is not installed..."), NO onCrash
//                other   -> notifyUser("Agent failed to start..."), onCrash(spawn_error)
//   1642-1652  child.on('error'/'stderr') crash-preview capture + log.warn
//   1658-1696  child.on('close') handler: drain buffered stdout, clearTurnWatchdog,
//                missing result/non-zero close -> budget cancellation + onCrash
//
// CONVENTIONS: mirrors the mocking strategy of the existing session.test.ts
// (mock node:child_process spawn, node:fs readFileSync, node:os homedir,
// logger, session-db). opencode-cli is the spawn-per-turn provider, so the
// 'error'/'exit' handlers are registered in sendTurn(), not spawnSession().
//
// DEAD/UNREACHABLE BRANCHES FLAGGED (do NOT attempt to cover): the
// assertNeverProvider default: branches in resolveProviderBinary/Args/Parser
// (session.ts lines ~212, 246, 327, 347) are unreachable given the
// constructor's isProviderId() guard (lines 499-504). The existing
// session.test.ts already proves the upstream rejection ("SessionManager
// constructor throws fail-fast for unknown providers (#447)"). Annotate the
// default: arms with /* v8 ignore */ rather than fake-covering them.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock/home'),
  userInfo: vi.fn(() => ({ username: 'testuser' })),
}));

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

vi.mock('../../../src/runtimes/agent/process-tree.ts', () => ({
  killSessionTree: vi.fn(async (target: { kill(signal: NodeJS.Signals): boolean }, signal: NodeJS.Signals) => {
    target.kill(signal);
  }),
}));

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));

vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  createSession: vi.fn(() => 42),
  incrementMessageCount: vi.fn(),
  updateSessionId: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateTranscriptPath: vi.fn(),
  backfillSessionProvider: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { killSessionTree } from '../../../src/runtimes/agent/process-tree.ts';
import { SessionManager } from '../../../src/runtimes/agent/session.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';

const CHAT_JID = 'test@s.whatsapp.net';

/**
 * Mock child that captures 'error', 'exit', and 'close' independently so tests
 * can drive the complete spawn-per-turn lifecycle.
 */
function makeHandlerChild(pid = 12345) {
  const stdin = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  (stdin as unknown as { write: ReturnType<typeof vi.fn> }).write = vi.fn(
    (_d: unknown, enc?: unknown, cb?: (err?: Error | null) => void) => {
      if (typeof enc === 'function') (enc as (e?: Error | null) => void)();
      else if (typeof cb === 'function') cb();
    },
  );
  (stdin as unknown as { end: ReturnType<typeof vi.fn> }).end = vi.fn();

  const child = {
    pid,
    stdin,
    stdout: Object.assign(new EventEmitter(), { setEncoding: () => {} }),
    stderr: new EventEmitter(),
    kill: vi.fn(),
    _errorCb: null as ((err: NodeJS.ErrnoException) => void) | null,
    _exitCb: null as ((code: number | null, signal: NodeJS.Signals | null) => void) | null,
    _closeCb: null as ((code: number | null, signal: NodeJS.Signals | null) => void) | null,
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'error') child._errorCb = cb as (err: NodeJS.ErrnoException) => void;
      if (event === 'exit') child._exitCb = cb as (c: number | null, s: NodeJS.Signals | null) => void;
      if (event === 'close') child._closeCb = cb as (c: number | null, s: NodeJS.Signals | null) => void;
      return child;
    }),
  };
  return child;
}

type HandlerChild = ReturnType<typeof makeHandlerChild>;

function makeDb(): Database {
  return {
    assertWritableCompatibility: vi.fn(),
    raw: { prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })), exec: vi.fn() },
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

describe('SessionManager spawn-per-turn child handlers (opencode-cli)', () => {
  let child: HandlerChild;

  beforeEach(() => {
    vi.clearAllMocks();
    child = makeHandlerChild();
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(child);
  });

  async function makeOpencodeSession(extra: Record<string, unknown> = {}) {
    const db = makeDb();
    const { messenger, sentMessages } = makeMessenger();
    const notifyUser = vi.fn();
    const onCrash = vi.fn();
    const sm = new SessionManager({
      db,
      messenger,
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'opencode-cli',
      model: 'glm/test-model',
      notifyUser,
      onCrash,
      ...extra,
    });
    // For spawn-per-turn providers, spawnSession() marks active without
    // spawning; the real process is spawned on the first sendTurn().
    await sm.spawnSession();
    return { sm, notifyUser, onCrash, sentMessages };
  }

  it('ENOENT spawn error notifies "not installed" and does NOT call onCrash', async () => {
    const { sm, notifyUser, onCrash } = await makeOpencodeSession();
    await sm.sendTurn('hello');

    expect(child._errorCb).toBeTypeOf('function');
    const err = Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException;
    child._errorCb!(err);

    expect(notifyUser).toHaveBeenCalledTimes(1);
    // Message embeds the resolved binary name ("opencode").
    expect(notifyUser.mock.calls[0]![0]).toMatch(/opencode is not installed/i);
    // ENOENT is a config error, not a transient crash — no onCrash.
    expect(onCrash).not.toHaveBeenCalled();
  });

  it('non-ENOENT spawn error notifies "failed to start" AND calls onCrash(spawn_error)', async () => {
    const { sm, notifyUser, onCrash } = await makeOpencodeSession();
    await sm.sendTurn('hello');

    // Generic spawn failure (no recognized code/message) so it hits the spawn_error
    // fallback class — EACCES would correctly classify as provider_permission_denied.
    const err = new Error('spawn failed: unexpected') as NodeJS.ErrnoException;
    child._errorCb!(err);

    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect(notifyUser.mock.calls[0]![0]).toMatch(/failed to start/i);
    expect(onCrash).toHaveBeenCalledTimes(1);
    const info = onCrash.mock.calls[0]![0] as Record<string, unknown>;
    // spawn_error crash info: no exit code/signal (process never started),
    // and the failure metadata records the spawn_error class + the message.
    expect(info.exitCode).toBeNull();
    expect(info.signal).toBeNull();
    expect(info.sessionId).toBeNull();
    expect(JSON.stringify(info)).toContain('spawn_error');
  });

  it('non-zero close on a spawn-per-turn turn calls onCrash with the exit code', async () => {
    const { sm, onCrash } = await makeOpencodeSession();
    await sm.sendTurn('hello');

    child._exitCb?.(7, null);
    await new Promise((resolve) => setImmediate(resolve));
    expect(onCrash).not.toHaveBeenCalled();

    child._closeCb?.(7, null);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onCrash).toHaveBeenCalledTimes(1);
    const info = onCrash.mock.calls[0]![0] as Record<string, unknown>;
    expect(info.exitCode).toBe(7);
  });

  it('drained close (code 0) without a terminal result fails closed exactly once', async () => {
    const events: AgentEvent[] = [];
    const { sm, notifyUser, onCrash } = await makeOpencodeSession({
      onEvent: (event: AgentEvent) => events.push(event),
    });
    await sm.sendTurn('hello');
    events.length = 0;

    child.stdout.emit('data', Buffer.from([
      JSON.stringify({
        type: 'tool_use',
        part: { callID: 'failed-call', state: { status: 'failed', output: 'tool failed' } },
      }),
      JSON.stringify({ type: 'step_finish', part: { reason: 'tool-calls' } }),
      '',
    ].join('\n')));

    child._exitCb?.(0, null);
    await new Promise((resolve) => setImmediate(resolve));
    expect(onCrash).not.toHaveBeenCalled();

    child._closeCb?.(0, null);
    child._closeCb?.(0, null);
    await new Promise((resolve) => setImmediate(resolve));

    expect(events.some((event) => event.type === 'result')).toBe(false);
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

  it('tool-calls remains intermediate and drained close emits one final unterminated stop result', async () => {
    const events: AgentEvent[] = [];
    const { sm, notifyUser, onCrash } = await makeOpencodeSession({
      onEvent: (event: AgentEvent) => events.push(event),
    });
    await sm.sendTurn('hello');
    events.length = 0;

    child.stdout.emit('data', Buffer.from([
      JSON.stringify({
        type: 'tool_use',
        part: { callID: 'completed-call', state: { status: 'completed', output: 'ok' } },
      }),
      JSON.stringify({ type: 'step_finish', part: { reason: 'tool-calls' } }),
      JSON.stringify({ type: 'text', part: { text: 'done' } }),
      '',
    ].join('\n')));
    expect(events.some((event) => event.type === 'result')).toBe(false);

    const finalResultLine = JSON.stringify({
      type: 'step_finish',
      part: {
        reason: 'stop',
        tokens: { input: 17, output: 23 },
        cost: 0.0042,
      },
    });
    child.stdout.emit('data', Buffer.from(finalResultLine));

    child._exitCb?.(0, null);
    await new Promise((resolve) => setImmediate(resolve));
    expect(events.some((event) => event.type === 'result')).toBe(false);

    child._closeCb?.(0, null);
    await new Promise((resolve) => setImmediate(resolve));

    expect(events.filter((event) => event.type === 'result')).toEqual([
      expect.objectContaining({
        type: 'result',
        text: null,
        inputTokens: 17,
        outputTokens: 23,
        costUsd: 0.0042,
      }),
    ]);
    expect(onCrash).not.toHaveBeenCalled();
    expect(notifyUser).not.toHaveBeenCalled();
    expect(sm.getStatus().turnInFlight).toBe(false);
  });

  it('does not commit a pending OpenCode stop candidate after SIGTERM', async () => {
    const events: AgentEvent[] = [];
    const { sm, notifyUser, onCrash } = await makeOpencodeSession({
      onEvent: (event: AgentEvent) => events.push(event),
    });
    await sm.sendTurn('hello');
    events.length = 0;

    // A stop record is only a candidate until the process exits cleanly. A
    // signal exit cannot prove that a later continuation was not truncated.
    child.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'step_finish',
      part: { reason: 'stop', tokens: { input: 11, output: 13 }, cost: 0.001 },
    })));

    child._exitCb?.(null, 'SIGTERM');
    child._closeCb?.(null, 'SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));

    expect(events.filter((event) => event.type === 'result')).toHaveLength(0);
    expect(onCrash).toHaveBeenCalledWith(expect.objectContaining({
      exitCode: null,
      signal: 'SIGTERM',
    }));
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect(sm.getStatus().turnInFlight).toBe(false);
  });

  it('a SIGTERM with no terminal result is still a crash (#1870 control)', async () => {
    const { sm, onCrash } = await makeOpencodeSession();
    await sm.sendTurn('hello');

    // No result was produced before the signal exit — this is a genuine crash
    // and must still be classified as one (the fix must not over-suppress).
    child._exitCb?.(null, 'SIGTERM');
    child._closeCb?.(null, 'SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));

    expect(onCrash).toHaveBeenCalledTimes(1);
    const info = onCrash.mock.calls[0]![0] as Record<string, unknown>;
    expect(info.exitCode).toBeNull();
    expect(info.signal).toBe('SIGTERM');
  });

  it('a clean spawn-per-turn exit clears the child so the next turn does not reap the dead one (#1861)', async () => {
    const spawnMock = spawn as ReturnType<typeof vi.fn>;
    const { sm } = await makeOpencodeSession();
    const firstChild = child;

    // Turn 1: deliver a terminal result, then a clean (code 0) exit.
    await sm.sendTurn('one');
    firstChild.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'step_finish', part: { reason: 'stop', tokens: { input: 1, output: 1 }, cost: 0 },
    })));
    firstChild._closeCb?.(0, null);
    await new Promise((resolve) => setImmediate(resolve));
    expect(firstChild.kill).not.toHaveBeenCalled();

    // Turn 2: a fresh child. A clean exit must terminally retire this.child, so
    // the turn-start guard does NOT try to reap the already-exited first tree
    // (which on a real host can fail with "Cannot replace provider while prior
    // process-tree cleanup is inconclusive").
    const secondChild = makeHandlerChild(23456);
    spawnMock.mockReturnValue(secondChild);
    await sm.sendTurn('two');

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(firstChild.kill).not.toHaveBeenCalled();
  });

  it('stops admitting later records in a chunk after a malformed record quarantines the session', async () => {
    const events: AgentEvent[] = [];
    let sm!: SessionManager;
    const session = await makeOpencodeSession({
      onEvent: (event: AgentEvent) => {
        events.push(event);
        if (event.type === 'parse_error') void sm.shutdown(false);
      },
    });
    sm = session.sm;
    await sm.sendTurn('hello');
    events.length = 0;

    child.stdout.emit('data', Buffer.from([
      '{not valid json}',
      JSON.stringify({
        type: 'step_finish',
        part: { reason: 'stop', tokens: { input: 1, output: 1 }, cost: 0 },
      }),
      '',
    ].join('\n')));

    expect(events).toEqual([
      { type: 'parse_error', line: '{not valid json}' },
    ]);
  });

  it('preserves the exact child handle when close-drain quarantine teardown is unproved', async () => {
    const teardownError = new Error('process tree proof failed');
    vi.mocked(killSessionTree).mockRejectedValueOnce(teardownError);
    const events: AgentEvent[] = [];
    let shutdownPromise: Promise<void> | null = null;
    let sm!: SessionManager;
    const session = await makeOpencodeSession({
      onEvent: (event: AgentEvent) => {
        events.push(event);
        if (event.type === 'parse_error') shutdownPromise = sm.shutdown(false);
      },
    });
    sm = session.sm;
    await sm.sendTurn('hello');
    events.length = 0;

    child.stdout.emit('data', Buffer.from('{not valid json}'));
    child._closeCb?.(0, null);

    expect(events).toEqual([
      { type: 'parse_error', line: '{not valid json}' },
    ]);
    expect(shutdownPromise).not.toBeNull();
    await expect(shutdownPromise).rejects.toBe(teardownError);
    expect((sm as unknown as { child: HandlerChild | null }).child).toBe(child);
  });

  it('spawn error followed by close settles the boundary only once', async () => {
    const { sm, onCrash } = await makeOpencodeSession();
    await sm.sendTurn('hello');

    const err = new Error('spawn failed: unexpected') as NodeJS.ErrnoException;
    child._errorCb!(err);
    child._closeCb?.(0, null);
    child._closeCb?.(0, null);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onCrash).toHaveBeenCalledTimes(1);
    expect(onCrash).toHaveBeenCalledWith(expect.objectContaining({ crashClass: 'spawn_error' }));
  });

  it('stderr output is captured into the crash preview (no throw, warn-logged)', async () => {
    const { sm } = await makeOpencodeSession();
    await sm.sendTurn('hello');

    // Should not throw — appendProviderCrashPreview accumulates the bytes.
    expect(() => child.stderr.emit('data', Buffer.from('opencode: fatal: boom\n'))).not.toThrow();

    // crashStderrPreview is private; assert it captured something via the
    // instance (cast for the test only).
    const preview = (sm as unknown as { crashStderrPreview: string }).crashStderrPreview;
    expect(preview).toContain('boom');
  });

  it('treats OpenCode diagnostic logs as watchdog progress without retaining them as crash output', async () => {
    const { sm } = await makeOpencodeSession();
    await sm.sendTurn('hello');
    const tick = vi.spyOn(sm, 'tickWatchdog');

    child.stderr.emit('data', Buffer.from(
      'timestamp=2026-07-22T15:29:58.519Z level=INFO run=runtime-test message=loop session.id=test step=20\n',
    ));

    expect(tick).toHaveBeenCalledTimes(1);
    const preview = (sm as unknown as { crashStderrPreview: string }).crashStderrPreview;
    expect(preview).not.toContain('session.id=test');
  });

  it('recognizes fragmented progress lines and preserves adjacent raw crash diagnostics', async () => {
    const { sm } = await makeOpencodeSession();
    await sm.sendTurn('hello');
    const tick = vi.spyOn(sm, 'tickWatchdog');

    child.stderr.emit('data', Buffer.from('timestamp=2026-07-22T15:29:58.519Z level=INFO run=runtime-test mes'));
    expect(tick).not.toHaveBeenCalled();
    child.stderr.emit('data', Buffer.from('sage=loop session.id=test step=20\nopencode: fatal: boom\n'));

    expect(tick).toHaveBeenCalledTimes(1);
    const preview = (sm as unknown as { crashStderrPreview: string }).crashStderrPreview;
    expect(preview).toContain('opencode: fatal: boom');
    expect(preview).not.toContain('session.id=test');
  });

  it('superseded child close (this.child !== child) is ignored', async () => {
    const { sm, onCrash } = await makeOpencodeSession();
    await sm.sendTurn('first');
    const firstChild = child;
    sm.completeProviderTurn();

    // After the first terminal boundary is admitted, the second turn spawns a
    // new child and supersedes the old process while its close is still pending.
    const secondChild = makeHandlerChild(22222);
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(secondChild);
    await sm.sendTurn('second');

    // Now complete the FIRST (stale) child's lifecycle — it should be ignored.
    firstChild._exitCb?.(9, null);
    firstChild._closeCb?.(9, null);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onCrash).not.toHaveBeenCalled();
    expect((sm as unknown as { child: HandlerChild | null }).child).toBe(secondChild);
  });

  it('holds ownership until clean close and ignores a stale duplicate close', async () => {
    const events: AgentEvent[] = [];
    let sm!: SessionManager;
    const session = await makeOpencodeSession({
      onEvent: (event: AgentEvent) => {
        events.push(event);
        if (event.type === 'result') sm.completeProviderTurn();
      },
    });
    sm = session.sm;
    await sm.sendTurn('first');
    const firstChild = child;
    firstChild.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: 'step_finish',
      part: { reason: 'stop', tokens: { input: 1, output: 1 }, cost: 0 },
    })}\n`));
    expect(events.filter((event) => event.type === 'result')).toHaveLength(0);
    expect(sm.getStatus().turnInFlight).toBe(true);

    const firstBoundary = sm.waitForProviderTurnToTerminalize();
    firstChild._closeCb?.(0, null);
    await firstBoundary;
    expect(events.filter((event) => event.type === 'result')).toHaveLength(1);
    expect(sm.getStatus().turnInFlight).toBe(false);

    const secondChild = makeHandlerChild(22222);
    vi.mocked(spawn).mockReturnValue(secondChild as unknown as ReturnType<typeof spawn>);
    await sm.sendTurn('second');
    expect(sm.getStatus().turnInFlight).toBe(true);

    // A duplicate close callback from the retired first child must not release
    // the exact provider-turn token now owned by the second child.
    firstChild._closeCb?.(0, null);
    await Promise.resolve();
    expect(sm.getStatus().turnInFlight).toBe(true);

    sm.completeProviderTurn();
    expect(sm.getStatus().turnInFlight).toBe(false);
  });

  it('clears an inactive exact child even after its ownership generation advances', async () => {
    let generationIdentity = { managerId: 'spawn-turn-inactive-exit', generation: 1 };
    const { sm } = await makeOpencodeSession();
    sm.bindGenerationOwnership(() => generationIdentity);
    await sm.sendTurn('generation one');
    const state = sm as unknown as { active: boolean; child: HandlerChild | null };
    generationIdentity = { managerId: 'spawn-turn-inactive-exit', generation: 2 };
    state.active = false;

    child._exitCb?.(0, null);
    child._closeCb?.(0, null);

    expect(state).toMatchObject({ active: false, child: null });
  });

  it('ignores stdout and stderr from a stale generation child', async () => {
    const events: AgentEvent[] = [];
    let generationIdentity = { managerId: 'spawn-turn-streams', generation: 1 };
    const { sm } = await makeOpencodeSession({ onEvent: (event: AgentEvent) => events.push(event) });
    sm.bindGenerationOwnership(() => generationIdentity);
    await sm.sendTurn('generation one');
    events.length = 0;
    generationIdentity = { managerId: 'spawn-turn-streams', generation: 2 };

    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: 'step_finish',
      part: { reason: 'stop', tokens: { input: 1, output: 2 }, cost: 0 },
    })}\n`));
    child.stderr.emit('data', Buffer.from('stale generation failure\n'));

    expect(events).toEqual([]);
    expect((sm as unknown as { crashStderrPreview: string }).crashStderrPreview).toBe('');
  });

  it('does not clear the current stalled-operation timer from a stale close', async () => {
    let generationIdentity = { managerId: 'spawn-turn-stalled-timer', generation: 1 };
    const { sm } = await makeOpencodeSession();
    sm.bindGenerationOwnership(() => generationIdentity);
    await sm.sendTurn('generation one');
    const currentTimer = { id: 'current-stalled-operation' } as unknown as ReturnType<typeof setTimeout>;
    const state = sm as unknown as { stalledOpKill: ReturnType<typeof setTimeout> | null };
    state.stalledOpKill = currentTimer;
    generationIdentity = { managerId: 'spawn-turn-stalled-timer', generation: 2 };

    child._exitCb?.(9, null);
    child._closeCb?.(9, null);

    expect(state.stalledOpKill).toBe(currentTimer);
  });
});
