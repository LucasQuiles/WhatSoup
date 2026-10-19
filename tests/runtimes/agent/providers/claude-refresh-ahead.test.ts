// Refresh-ahead and refresh-lock kill grace (claude-refresh-ahead.ts).
//
// The CLI refreshes its OAuth token inside any `claude` run once the stored
// access token is within 5 minutes of expiry, and a run killed between the
// server's rotation and the local save loses the rotated refresh token. So
// before a killable non-turn probe, WhatSoup runs one `claude auth status
// --json` that it never times out and never signals; and before it signals a
// probe it waits while the CLI's refresh lock is held. Fixtures only: the
// stores are injected readers and the children are fakes.
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REFRESH_AHEAD_HARD_CAP_MS,
  REFRESH_AHEAD_MS,
  REFRESH_AHEAD_WAIT_MS,
  REFRESH_LOCK_GRACE_MS,
  claudeRefreshLockGrace,
  refreshClaudeLoginAhead,
  type ClaudeRefreshAheadDeps,
} from '../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts';
import { probeBinaryCommand } from '../../../../src/runtimes/agent/providers/binary-preflight.ts';

const SVC = ['Claude', 'Code-credentials'].join(' ');
const START = new Date('2026-10-19T08:00:00.000Z');
const ACCESS_SENTINEL = 'access-token-sentinel-91c2';
const REFRESH_SENTINEL = 'refresh-token-sentinel-4be7';

type FakeChild = EventEmitter & {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function fakeChild(pid: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

function capture() {
  const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const push = (obj: unknown, msg: string): void => { lines.push({ obj: obj as Record<string, unknown>, msg }); };
  return { lines, log: { info: push, warn: push, error: push } };
}

function store(expiresAt: number | undefined): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: ACCESS_SENTINEL,
      refreshToken: REFRESH_SENTINEL,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    },
  });
}

let dirSeq = 0;
/** A fresh config dir per test so the per-dir in-flight dedupe never leaks across tests. */
function configDir(): string {
  dirSeq += 1;
  return `/tmp/refresh-ahead-fixture-${dirSeq}/.claude`;
}

function harness(over: Partial<ClaudeRefreshAheadDeps> & { fileStore?: string | null } = {}) {
  const children: FakeChild[] = [];
  const spawnImpl = vi.fn(() => {
    const child = fakeChild(9000 + children.length);
    children.push(child);
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  const { lines, log } = capture();
  const readFileStore = vi.fn(() => (over.fileStore === undefined ? null : over.fileStore));
  const deps: ClaudeRefreshAheadDeps = {
    platform: 'linux',
    readFileStore,
    spawnImpl,
    log,
    ...over,
  };
  return { deps, children, spawnImpl, lines, readFileStore };
}

beforeEach(() => { vi.useFakeTimers({ now: START }); });
afterEach(() => { vi.useRealTimers(); });

describe('refreshClaudeLoginAhead: when it runs', () => {
  it('runs no child when the stored token is far from expiry', async () => {
    const dir = configDir();
    const h = harness({ fileStore: store(START.getTime() + REFRESH_AHEAD_MS + 60_000) });
    await expect(refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps))
      .resolves.toMatchObject({ outcome: 'not-needed' });
    expect(h.spawnImpl).not.toHaveBeenCalled();
    expect(h.readFileStore).toHaveBeenCalledWith(`${dir}/.credentials.json`);
  });

  it.each([
    ['unknown (no store)', null, 'expiry-unknown'],
    ['unknown (no expiresAt)', store(undefined), 'expiry-unknown'],
    ['already past', store(START.getTime() - 1), 'expired'],
    ['within the window', store(START.getTime() + REFRESH_AHEAD_MS - 1_000), 'within-window'],
  ] as const)('runs exactly one auth status child when expiresAt is %s', async (_label, fileStore, reason) => {
    const dir = configDir();
    const env = { CLAUDE_CONFIG_DIR: dir, HOME: '/tmp/refresh-ahead-home' };
    const h = harness({ fileStore });
    const run = refreshClaudeLoginAhead('claude', env, h.deps);
    expect(h.spawnImpl).toHaveBeenCalledOnce();
    const [binary, args, options] = (h.spawnImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(binary).toBe('claude');
    expect(args).toEqual(['auth', 'status', '--json']);
    expect((options as { env: unknown }).env).toBe(env);
    expect((options as { signal?: unknown }).signal).toBeUndefined();
    expect((options as { timeout?: unknown }).timeout).toBeUndefined();
    h.children[0]!.emit('close', 0, null);
    await expect(run).resolves.toMatchObject({ outcome: 'ran', reason, exitCode: 0 });
  });

  it('reads the keychain item first on darwin, the way the CLI does', async () => {
    const dir = configDir();
    const readKeychain = vi.fn((_service: string) => store(START.getTime() + 3_600_000));
    const h = harness({ platform: 'darwin', readKeychain, fileStore: store(START.getTime() - 1) });
    await expect(refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps))
      .resolves.toMatchObject({ outcome: 'not-needed' });
    expect(readKeychain).toHaveBeenCalledOnce();
    expect(readKeychain.mock.calls[0]![0]).toMatch(new RegExp(`^${SVC}-[0-9a-f]{8}$`));
    expect(h.spawnImpl).not.toHaveBeenCalled();
  });

  it('keys the keychain item and the file store to CLAUDE_SECURESTORAGE_CONFIG_DIR when it is set', async () => {
    // Oracle: printf %s /tmp/refresh-ahead-secure/.claude | shasum -a 256 | cut -c1-8
    const readKeychain = vi.fn((_service: string): string | null => null);
    const h = harness({ platform: 'darwin', readKeychain, fileStore: store(START.getTime() + 3_600_000) });
    await refreshClaudeLoginAhead('claude', {
      CLAUDE_CONFIG_DIR: configDir(),
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/tmp/refresh-ahead-secure/.claude',
    }, h.deps);
    expect(readKeychain).toHaveBeenCalledWith(`${SVC}-165a2af3`);
    expect(h.readFileStore).toHaveBeenCalledWith('/tmp/refresh-ahead-secure/.claude/.credentials.json');
  });
});

describe('refreshClaudeLoginAhead: never killed', () => {
  it('bounds the caller wait, never the child: still-running after the wait, child runs to its own exit', async () => {
    const h = harness({ fileStore: store(START.getTime() + 1_000) });
    const run = refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: configDir() }, h.deps);
    await vi.advanceTimersByTimeAsync(REFRESH_AHEAD_WAIT_MS - 1);
    let early: unknown = 'pending';
    void run.then((r) => { early = r; });
    await vi.advanceTimersByTimeAsync(0);
    expect(early).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await expect(run).resolves.toEqual({ outcome: 'still-running' });

    // Far past any probe budget and the CLI's own lock staleness: still not killed.
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(h.children[0]!.kill).not.toHaveBeenCalled();
    expect(h.lines.some((l) => l.obj.event === 'claude_probe_still_running')).toBe(true);

    h.children[0]!.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    const exit = h.lines.find((l) => l.obj.event === 'claude_probe_exit')!;
    expect(exit.obj).toMatchObject({
      purpose: 'refresh-ahead',
      pid: 9000,
      durationMs: 10 * 60_000,
      exitCode: 0,
      signal: null,
      killedByProbeTimeout: false,
      termination: null,
    });
    expect(h.children[0]!.kill).not.toHaveBeenCalled();
  });

  it('a later caller while the child still runs joins it and is bounded too (no second child)', async () => {
    const dir = configDir();
    const h = harness({ fileStore: store(START.getTime() + 1_000) });
    void refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps);
    await vi.advanceTimersByTimeAsync(REFRESH_AHEAD_WAIT_MS + 5_000);
    const later = refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps);
    await vi.advanceTimersByTimeAsync(REFRESH_AHEAD_WAIT_MS);
    await expect(later).resolves.toEqual({ outcome: 'still-running' });
    expect(h.spawnImpl).toHaveBeenCalledOnce();
    h.children[0]!.emit('close', 0, null);
  });

  it('after the hard cap a hung child stops blocking (error line), is still not killed, and a new caller runs its own check', async () => {
    const dir = configDir();
    const h = harness({ fileStore: store(START.getTime() + 1_000) });
    void refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps);
    await vi.advanceTimersByTimeAsync(REFRESH_AHEAD_HARD_CAP_MS);
    const hung = h.lines.find((l) => l.obj.event === 'claude_refresh_ahead_hung');
    expect(hung).toBeDefined();
    expect(hung!.obj).toMatchObject({ purpose: 'refresh-ahead', pid: 9000, elapsedMs: REFRESH_AHEAD_HARD_CAP_MS });
    expect(h.children[0]!.kill).not.toHaveBeenCalled();

    const next = refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps);
    expect(h.spawnImpl).toHaveBeenCalledTimes(2);
    h.children[1]!.emit('close', 0, null);
    await expect(next).resolves.toMatchObject({ outcome: 'ran' });
    expect(h.children[0]!.kill).not.toHaveBeenCalled();
    h.children[0]!.emit('close', 0, null);
  });

  it('spawns the child detached (its own process group), output discarded', async () => {
    const h = harness();
    const run = refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: configDir() }, h.deps);
    const options = (h.spawnImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![2] as { detached?: unknown; stdio?: unknown };
    expect(options.detached).toBe(true);
    expect(options.stdio).toEqual(['ignore', 'ignore', 'ignore']);
    h.children[0]!.emit('close', 0, null);
    await run;
  });

  it('logs a spawn line and an exit line in the probe lifecycle shape', async () => {
    const dir = configDir();
    const h = harness();
    const run = refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps);
    await vi.advanceTimersByTimeAsync(2_500);
    h.children[0]!.emit('close', 1, null);
    await run;
    expect(h.lines.map((l) => l.obj.event)).toEqual(['claude_probe_spawn', 'claude_probe_exit']);
    expect(h.lines[0]!.obj).toMatchObject({
      purpose: 'refresh-ahead',
      reason: 'expiry-unknown',
      pid: 9000,
      startedAt: START.toISOString(),
    });
    expect(h.lines[0]!.obj.credentialService).toMatch(new RegExp(`^${SVC}-[0-9a-f]{8}$`));
    expect(h.lines[1]!.obj).toMatchObject({ purpose: 'refresh-ahead', durationMs: 2_500, exitCode: 1, spawnFailed: false });
  });
});

describe('refreshClaudeLoginAhead: one child per config dir', () => {
  it('concurrent callers for one config dir share one child and one result', async () => {
    const dir = configDir();
    const h = harness({ fileStore: store(START.getTime() + 1_000) });
    const a = refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps);
    const b = refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps);
    expect(h.spawnImpl).toHaveBeenCalledOnce();
    h.children[0]!.emit('close', 0, null);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);

    // Once settled, a later caller runs its own check again.
    const c = refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps);
    expect(h.spawnImpl).toHaveBeenCalledTimes(2);
    h.children[1]!.emit('close', 0, null);
    await c;
  });

  it('one storage dir spelled with and without a trailing slash shares one child', async () => {
    const dir = configDir();
    const h = harness({ fileStore: store(START.getTime() + 1_000) });
    const a = refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps);
    const b = refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: `${dir}/` }, h.deps);
    expect(h.spawnImpl).toHaveBeenCalledOnce();
    h.children[0]!.emit('close', 0, null);
    await Promise.all([a, b]);
  });

  it('different config dirs do not share a child', async () => {
    const h = harness({ fileStore: store(START.getTime() + 1_000) });
    const a = refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: configDir() }, h.deps);
    const b = refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: configDir() }, h.deps);
    expect(h.spawnImpl).toHaveBeenCalledTimes(2);
    for (const child of h.children) child.emit('close', 0, null);
    await Promise.all([a, b]);
  });
});

describe('refreshClaudeLoginAhead: content-free', () => {
  it('no token value, store content or config dir reaches any log line', async () => {
    const dir = configDir();
    const h = harness({ fileStore: store(START.getTime() - 5) });
    const run = refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps);
    await vi.advanceTimersByTimeAsync(70_000);
    h.children[0]!.emit('close', 0, null);
    const result = await run;
    const text = JSON.stringify([h.lines, result]);
    expect(text).not.toContain(ACCESS_SENTINEL);
    expect(text).not.toContain(REFRESH_SENTINEL);
    expect(text).not.toContain(dir);
    // The child's output is never captured at all.
    const options = (h.spawnImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![2] as { stdio: unknown };
    expect(options.stdio).toEqual(['ignore', 'ignore', 'ignore']);
  });
});

describe('claudeRefreshLockGrace', () => {
  const now = () => Date.now();

  it('applies no grace when no lock exists', () => {
    const h = capture();
    expect(claudeRefreshLockGrace({ CLAUDE_CONFIG_DIR: configDir() }, 'test', { statMtimeMs: () => null, now, log: h.log }))
      .toBeNull();
    expect(h.lines).toEqual([]);
  });

  it('applies no grace when the lock is stale (older than 60 s)', () => {
    expect(claudeRefreshLockGrace({ CLAUDE_CONFIG_DIR: configDir() }, 'test', {
      statMtimeMs: () => now() - 60_001,
      now,
    })).toBeNull();
  });

  it('checks the CLI lock in the config dir and the legacy lock beside it', () => {
    const dir = configDir();
    const seen: string[] = [];
    claudeRefreshLockGrace({ CLAUDE_CONFIG_DIR: dir }, 'test', {
      statMtimeMs: (path) => { seen.push(path); return null; },
      realpath: (path) => path,
      now,
    });
    expect(seen).toEqual([`${dir}/.oauth_refresh.lock`, `${dir}.lock`]);
  });

  it('waits while a fresh lock exists and proceeds once it is gone', async () => {
    const h = capture();
    let lockMtime: number | null = now() - 1_000;
    const grace = claudeRefreshLockGrace({ CLAUDE_CONFIG_DIR: configDir() }, 'primary-model-probe', {
      statMtimeMs: (path) => (path.endsWith('.oauth_refresh.lock') ? lockMtime : null),
      now,
      log: h.log,
    });
    expect(grace).not.toBeNull();
    let done = false;
    void grace!.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(done).toBe(false);
    lockMtime = null;
    await vi.advanceTimersByTimeAsync(250);
    await expect(grace).resolves.toMatchObject({ outcome: 'lock-released', waitedMs: 3_250 });
    expect(h.lines.at(-1)!.obj).toMatchObject({
      event: 'claude_refresh_lock_grace',
      purpose: 'primary-model-probe',
      outcome: 'lock-released',
      waitedMs: 3_250,
    });
  });

  it('proceeds once a held lock goes stale', async () => {
    const lockMtime = now() - 59_000;
    const grace = claudeRefreshLockGrace({ CLAUDE_CONFIG_DIR: configDir() }, 'test', {
      statMtimeMs: (path) => (path.endsWith('.oauth_refresh.lock') ? lockMtime : null),
      now,
    });
    await vi.advanceTimersByTimeAsync(1_250);
    await expect(grace).resolves.toMatchObject({ outcome: 'lock-released' });
  });

  it('is bounded: a lock that stays fresh is waited for at most REFRESH_LOCK_GRACE_MS', async () => {
    const h = capture();
    const grace = claudeRefreshLockGrace({ CLAUDE_CONFIG_DIR: configDir() }, 'test', {
      statMtimeMs: () => now() - 100,
      now,
      log: h.log,
    });
    let done = false;
    void grace!.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(REFRESH_LOCK_GRACE_MS - 250);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    await expect(grace).resolves.toMatchObject({ outcome: 'grace-exhausted', waitedMs: REFRESH_LOCK_GRACE_MS });
    expect(h.lines.at(-1)!.obj).toMatchObject({ event: 'claude_refresh_lock_grace', outcome: 'grace-exhausted' });
    expect(REFRESH_LOCK_GRACE_MS).toBeGreaterThanOrEqual(20_000);
    expect(REFRESH_LOCK_GRACE_MS).toBeLessThanOrEqual(30_000);
  });
});

describe('probeBinaryCommand termination grace', () => {
  it('delays the timeout kill until the grace settles, then signals', async () => {
    const child = fakeChild(4100);
    const spawnImpl = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    let release!: () => void;
    const grace = new Promise<void>((resolve) => { release = resolve; });
    const result = probeBinaryCommand('claude', ['-p', 'x'], {}, { timeoutMs: 15_000, terminationGrace: () => grace }, spawnImpl);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(result).resolves.toMatchObject({ status: 'failed' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('never signals a child that exits during the grace', async () => {
    const child = fakeChild(4101);
    const spawnImpl = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    let release!: () => void;
    const grace = new Promise<void>((resolve) => { release = resolve; });
    void probeBinaryCommand('claude', ['-p', 'x'], {}, { timeoutMs: 15_000, terminationGrace: () => grace }, spawnImpl);
    await vi.advanceTimersByTimeAsync(15_000);
    child.emit('close', 0, null);
    release();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('a child that exits on its own during the grace is not reported as killed', async () => {
    const child = fakeChild(4103);
    const spawnImpl = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    let release!: () => void;
    const grace = new Promise<void>((resolve) => { release = resolve; });
    const exits: unknown[] = [];
    void probeBinaryCommand('claude', ['-p', 'x'], {}, {
      timeoutMs: 15_000,
      terminationGrace: () => grace,
      onExited: (exit) => { exits.push(exit); },
    }, spawnImpl);
    await vi.advanceTimersByTimeAsync(15_000);
    child.emit('close', 0, null);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(child.kill).not.toHaveBeenCalled();
    expect(exits).toEqual([expect.objectContaining({ exitCode: 0, signal: null, killedByTimeout: false, killedByAbort: false })]);
  });

  it('a child signalled after the grace is reported as killed by the timeout', async () => {
    const child = fakeChild(4104);
    const spawnImpl = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    let release!: () => void;
    const grace = new Promise<void>((resolve) => { release = resolve; });
    const exits: unknown[] = [];
    void probeBinaryCommand('claude', ['-p', 'x'], {}, {
      timeoutMs: 15_000,
      terminationGrace: () => grace,
      onExited: (exit) => { exits.push(exit); },
    }, spawnImpl);
    await vi.advanceTimersByTimeAsync(15_000);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit('close', null, 'SIGTERM');
    expect(exits).toEqual([expect.objectContaining({ signal: 'SIGTERM', killedByTimeout: true })]);
  });

  it('signals at once when no grace applies', async () => {
    const child = fakeChild(4102);
    const spawnImpl = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    void probeBinaryCommand('claude', ['-p', 'x'], {}, { timeoutMs: 15_000, terminationGrace: () => null }, spawnImpl);
    vi.advanceTimersByTime(15_000);
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
