// Refresh-ahead and refresh-lock kill grace (claude-refresh-ahead.ts).
//
// The CLI refreshes its OAuth token inside any `claude` run once the stored
// access token is within 5 minutes of expiry, and a run killed between the
// server's rotation and the local save loses the rotated refresh token. So
// before a killable non-turn probe, WhatSoup runs one `claude auth status
// --json` that it never times out and never signals; and before it signals a
// probe it waits while the CLI's refresh lock is held. Fixtures only: the
// stores are injected readers and the children are fakes.
import { EventEmitter, once } from 'node:events';
import { spawn as spawnProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  unref: ReturnType<typeof vi.fn>;
};

function fakeChild(pid: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  child.unref = vi.fn();
  return child;
}

async function nativeChildHeldUntilEof() {
  const native = spawnProcess(process.execPath, [
    '-e',
    "process.stdin.once('end', () => process.exit(0)); process.stdout.write('ready\\n'); process.stdin.resume();",
  ], { stdio: ['pipe', 'pipe', 'ignore'] });
  const ended = new Promise<void>((resolve) => { native.once('close', () => resolve()); });
  const ready = new Promise<string>((resolve, reject) => {
    let output = '';
    const cleanup = (): void => {
      native.stdout!.off('data', onData);
      native.off('close', onClose);
      native.off('error', onError);
    };
    const onData = (chunk: Buffer | string): void => {
      output += String(chunk);
      const newline = output.indexOf('\n');
      if (newline === -1) return;
      cleanup();
      resolve(output.slice(0, newline));
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`native child closed before readiness (code ${code}, signal ${signal})`));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    native.stdout!.on('data', onData);
    native.once('close', onClose);
    native.once('error', onError);
  });
  try {
    expect(await ready).toBe('ready');
    return { native, ended };
  } catch (error) {
    if (native.exitCode === null) native.kill();
    await ended;
    throw error;
  }
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

const privateStoreRoots: string[] = [];
/** A fresh config dir per test so the per-dir in-flight dedupe never leaks across tests. */
function configDir(): string {
  return privateStoreDir();
}

function privateStoreDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'whatsoup-refresh-claim-'));
  privateStoreRoots.push(root);
  const dir = join(root, '.claude');
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

const OWNER_DIR = '.whatsoup-refresh-ahead';
const OWNER_FILE = 'owner.json';
const OWNER_MAX_BYTES = 4 * 1024;

/** Raw fixtures for the proposed production claim; no fake claim parser is used. */
function ownerPath(configDir: string): string {
  return join(configDir, OWNER_DIR, OWNER_FILE);
}

function writeOwnerFixture(configDir: string, raw = 'untrusted-owner-claim'): string {
  const path = ownerPath(configDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  writeFileSync(path, raw, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function claimFingerprint(path: string): Pick<Stats, 'ino' | 'mode' | 'nlink' | 'size'> {
  const state = lstatSync(path);
  return { ino: state.ino, mode: state.mode, nlink: state.nlink, size: state.size };
}

type ProcessObservation = { state: 'alive'; birthToken: string } | { state: 'absent' | 'unknown' };
function fixtureBirthToken(pid: number): string {
  return `refresh-owner-v1:fixture-boot:fixture-birth:${pid}`;
}
const fixtureProcessIdentity = {
  hostId: 'refresh-test-host',
  inspectProcess: (pid: number): ProcessObservation => ({ state: 'alive', birthToken: fixtureBirthToken(pid) }),
};

function harness(over: Partial<ClaudeRefreshAheadDeps> & {
  fileStore?: string | null;
  hostId?: string;
  inspectProcess?: (pid: number) => ProcessObservation;
} = {}) {
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
    ...fixtureProcessIdentity,
    ...over,
  };
  return { deps, children, spawnImpl, lines, readFileStore };
}

beforeEach(() => { vi.useFakeTimers({ now: START }); });
afterEach(() => {
  vi.doUnmock('node:fs');
  vi.doUnmock('../../../../src/lib/private-fs-isolated.ts');
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of privateStoreRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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
    const secureStore = privateStoreDir();
    const service = `${SVC}-${createHash('sha256').update(secureStore).digest('hex').slice(0, 8)}`;
    const readKeychain = vi.fn((_service: string): string | null => null);
    const h = harness({ platform: 'darwin', readKeychain, fileStore: store(START.getTime() + 3_600_000) });
    await expect(refreshClaudeLoginAhead('claude', {
      CLAUDE_CONFIG_DIR: configDir(),
      CLAUDE_SECURESTORAGE_CONFIG_DIR: secureStore,
    }, h.deps)).resolves.toEqual({ outcome: 'not-needed' });
    expect(readKeychain).toHaveBeenCalledWith(service);
    expect(h.readFileStore).toHaveBeenCalledWith(join(secureStore, '.credentials.json'));
  });
});

describe('refreshClaudeLoginAhead: durable owner recovery', () => {
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('retains an invalid owner PID %s without probing it', async (pid) => {
    const dir = privateStoreDir();
    const raw = JSON.stringify({ version: 2, fence: 'invalid-pid', hostId: 'refresh-test-host', pid, processBirthToken: fixtureBirthToken(8000) });
    const path = writeOwnerFixture(dir, raw);
    const inspectProcess = vi.fn((): ProcessObservation => ({ state: 'absent' }));
    const h = harness({ inspectProcess });
    await expect(refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps))
      .resolves.toEqual({ outcome: 'owner-unavailable' });
    expect(inspectProcess).not.toHaveBeenCalled();
    expect(h.spawnImpl).not.toHaveBeenCalled();
    expect(readFileSync(path, 'utf8')).toBe(raw);
  });

  it('keeps a child whose identity cannot be established alertable without killing or duplicating it', async () => {
    const dir = privateStoreDir();
    const h = harness({ inspectProcess: () => ({ state: 'unknown' }) });
    const run = refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps);
    await expect(run).resolves.toEqual({ outcome: 'owner-unavailable' });
    const raw = readFileSync(ownerPath(dir), 'utf8');
    await expect(refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps))
      .resolves.toEqual({ outcome: 'owner-unavailable' });
    expect(h.spawnImpl).toHaveBeenCalledOnce();
    expect(readFileSync(ownerPath(dir), 'utf8')).toBe(raw);
    expect(h.children[0]!.kill).not.toHaveBeenCalled();
    h.children[0]!.emit('close', 0, null);
  });

  it.each(['before-write', 'after-write'] as const)('reports %s publication failure while preserving the live child and claim', async (failure) => {
    const dir = privateStoreDir();
    const h = harness();
    const actual = await vi.importActual<typeof import('../../../../src/lib/private-fs-isolated.ts')>('../../../../src/lib/private-fs-isolated.ts');
    vi.doMock('../../../../src/lib/private-fs-isolated.ts', () => ({
      ...actual,
      writeAtomicPrivateFileIsolatedSync: (...args: Parameters<typeof actual.writeAtomicPrivateFileIsolatedSync>) => {
        if (failure === 'after-write') actual.writeAtomicPrivateFileIsolatedSync(...args);
        throw new Error('fixture publication failure');
      },
    }));
    vi.resetModules();
    const fresh = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    await expect(fresh.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps))
      .resolves.toEqual({ outcome: 'owner-unavailable' });
    const raw = readFileSync(ownerPath(dir), 'utf8');
    await expect(fresh.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps))
      .resolves.toEqual({ outcome: 'owner-unavailable' });
    expect(h.spawnImpl).toHaveBeenCalledOnce();
    expect(readFileSync(ownerPath(dir), 'utf8')).toBe(raw);
    expect(existsSync(join(dirname(ownerPath(dir)), 'owner.mutation.json'))).toBe(false);
    expect(h.children[0]!.kill).not.toHaveBeenCalled();
    h.children[0]!.emit('close', 0, null);
  });

  it('observes close during identity publication and releases the claim after publication completes', async () => {
    const dir = privateStoreDir();
    const h = harness();
    const actual = await vi.importActual<typeof import('../../../../src/lib/private-fs-isolated.ts')>('../../../../src/lib/private-fs-isolated.ts');
    vi.doMock('../../../../src/lib/private-fs-isolated.ts', () => ({
      ...actual,
      writeAtomicPrivateFileIsolatedSync: (...args: Parameters<typeof actual.writeAtomicPrivateFileIsolatedSync>) => {
        h.children[0]!.emit('close', 0, null);
        actual.writeAtomicPrivateFileIsolatedSync(...args);
      },
    }));
    vi.resetModules();
    const fresh = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    await expect(fresh.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps))
      .resolves.toMatchObject({ outcome: 'ran', exitCode: 0 });
    expect(existsSync(ownerPath(dir))).toBe(false);
    expect(existsSync(join(dirname(ownerPath(dir)), 'owner.mutation.json'))).toBe(false);
    expect(h.spawnImpl).toHaveBeenCalledOnce();
    expect(h.children[0]!.kill).not.toHaveBeenCalled();
  });

  it.each(['busy', 'malformed', 'crashed'] as const)('retains a %s mutation guard and reports unavailable without reading credentials', async (kind) => {
    const dir = privateStoreDir();
    const path = writeOwnerFixture(dir, JSON.stringify({ version: 2, fence: 'dead-child', hostId: 'refresh-test-host', pid: 9000, processBirthToken: fixtureBirthToken(9000) }));
    const guard = join(dirname(path), 'owner.mutation.json');
    const raw = kind === 'malformed' ? '{broken' : JSON.stringify({ version: 1, fence: `guard-${kind}` });
    writeFileSync(guard, raw, { mode: 0o600 });
    const before = readFileSync(path, 'utf8');
    const h = harness({ inspectProcess: () => ({ state: 'absent' }) });
    await expect(refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps))
      .resolves.toEqual({ outcome: 'owner-unavailable' });
    expect(h.spawnImpl).not.toHaveBeenCalled();
    expect(h.readFileStore).not.toHaveBeenCalled();
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readFileSync(guard, 'utf8')).toBe(raw);
  });

  it('serializes two restarted reconcilers through the final unlink and successor publication', async () => {
    const dir = privateStoreDir();
    const path = writeOwnerFixture(dir, JSON.stringify({ version: 2, fence: 'dead-child', hostId: 'refresh-test-host', pid: 8000, processBirthToken: fixtureBirthToken(8000) }));
    const inspectProcess = (pid: number): ProcessObservation => pid === 8000
      ? { state: 'absent' } : fixtureProcessIdentity.inspectProcess(pid);
    const a = harness({ inspectProcess });
    const b = harness({ inspectProcess });
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    let contender: Promise<unknown> | undefined;
    let invokeContender: (() => Promise<unknown>) | undefined;
    vi.doMock('node:fs', () => ({
      ...actualFs,
      unlinkSync: (target: Parameters<typeof actualFs.unlinkSync>[0]) => {
        if (target === path && invokeContender) {
          const invoke = invokeContender;
          invokeContender = undefined;
          // Interleave after the deleter's final read, at the real mutation.
          contender = invoke();
        }
        actualFs.unlinkSync(target);
      },
    }));
    vi.resetModules();
    const first = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    vi.resetModules();
    const second = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    invokeContender = () => second.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, b.deps);
    const run = first.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, a.deps);
    expect(a.spawnImpl).toHaveBeenCalledOnce();
    expect(contender).toBeDefined();
    await expect(contender).resolves.toEqual({ outcome: 'owner-unavailable' });
    expect(b.spawnImpl).not.toHaveBeenCalled();
    const successor = readFileSync(path, 'utf8');
    await expect(second.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, b.deps))
      .resolves.toEqual({ outcome: 'still-running' });
    expect(readFileSync(path, 'utf8')).toBe(successor);
    expect(b.spawnImpl).not.toHaveBeenCalled();
    expect(a.children[0]!.kill).not.toHaveBeenCalled();
    a.children[0]!.emit('close', 0, null);
    await expect(run).resolves.toMatchObject({ outcome: 'ran' });
  });

  it('keeps the same native child held when the restarted parent changes timezone and locale', async () => {
    const previous = { TZ: process.env.TZ, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL };
    const { native, ended } = await nativeChildHeldUntilEof();
    expect(native.pid).toBeGreaterThan(0);
    expect(native.pid).not.toBe(process.pid);
    const child = fakeChild(native.pid!);
    const nativeLiveness = vi.spyOn(process, 'kill');
    const dir = privateStoreDir();
    const env = { CLAUDE_CONFIG_DIR: dir };
    const first = harness({ hostId: hostname(), inspectProcess: undefined,
      spawnImpl: (() => child) as unknown as typeof import('node:child_process').spawn });
    try {
      process.env.TZ = 'America/New_York';
      process.env.LANG = 'en_US.UTF-8';
      process.env.LC_ALL = 'en_US.UTF-8';
      vi.resetModules();
      const original = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
      const run = original.refreshClaudeLoginAhead('claude', env, first.deps);
      expect(JSON.parse(readFileSync(ownerPath(dir), 'utf8'))).toMatchObject({
        version: 2, pid: native.pid, hostId: hostname(),
        processBirthToken: expect.stringMatching(/^refresh-owner-v1:/),
      });
      expect(nativeLiveness).toHaveBeenCalledWith(native.pid, 0);
      await vi.advanceTimersByTimeAsync(REFRESH_AHEAD_WAIT_MS);
      await expect(run).resolves.toEqual({ outcome: 'still-running' });
      const before = readFileSync(ownerPath(dir), 'utf8');
      process.env.TZ = 'UTC';
      process.env.LANG = 'C';
      process.env.LC_ALL = 'C';
      vi.resetModules();
      const restarted = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
      const next = harness({ hostId: hostname(), inspectProcess: undefined });
      nativeLiveness.mockClear();
      await expect(restarted.refreshClaudeLoginAhead('claude', env, next.deps))
        .resolves.toEqual({ outcome: 'still-running' });
      expect(next.spawnImpl).not.toHaveBeenCalled();
      expect(nativeLiveness).toHaveBeenCalledWith(native.pid, 0);
      expect(readFileSync(ownerPath(dir), 'utf8')).toBe(before);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      child.emit('close', 0, null);
      native.stdin.end();
      await ended;
    }
  });

  it('uses native liveness to recover a child that exited after its parent lost observation', async () => {
    const { native, ended } = await nativeChildHeldUntilEof();
    expect(native.pid).toBeGreaterThan(0);
    const child = fakeChild(native.pid!);
    const dir = privateStoreDir();
    let retainedClaim: string;
    try {
      const producer = harness({ hostId: hostname(), inspectProcess: undefined,
        spawnImpl: (() => child) as unknown as typeof import('node:child_process').spawn });
      const run = refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, producer.deps);
      retainedClaim = readFileSync(ownerPath(dir), 'utf8');
      expect(JSON.parse(retainedClaim)).toMatchObject({ version: 2, pid: native.pid,
        processBirthToken: expect.stringMatching(/^refresh-owner-v1:/) });
      child.emit('close', 0, null);
      await expect(run).resolves.toMatchObject({ outcome: 'ran' });
    } finally {
      child.emit('close', 0, null);
      native.stdin.end();
      await ended;
    }
    const path = writeOwnerFixture(dir, retainedClaim!);
    const nativeLiveness = vi.spyOn(process, 'kill');
    const h = harness({ hostId: hostname(), inspectProcess: undefined, fileStore: store(START.getTime() + 3_600_000) });
    await expect(refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps))
      .resolves.toEqual({ outcome: 'not-needed' });
    expect(h.spawnImpl).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
    expect(nativeLiveness).toHaveBeenCalledWith(native.pid, 0);
    expect(nativeLiveness.mock.results).toContainEqual({ type: 'throw', value: expect.objectContaining({ code: 'ESRCH' }) });
  });

  it('never treats EPERM as proof that the native child exited', async () => {
    const dir = privateStoreDir();
    const child = fakeChild(process.pid);
    const producer = harness({ hostId: hostname(), inspectProcess: undefined,
      spawnImpl: (() => child) as unknown as typeof import('node:child_process').spawn });
    const first = refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, producer.deps);
    const before = readFileSync(ownerPath(dir), 'utf8');
    expect(JSON.parse(before)).toMatchObject({ version: 2, pid: process.pid, processBirthToken: expect.any(String) });
    child.emit('close', 0, null);
    await expect(first).resolves.toMatchObject({ outcome: 'ran' });
    const path = writeOwnerFixture(dir, before);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    const h = harness({ hostId: hostname(), inspectProcess: undefined });
    await expect(refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps))
      .resolves.toEqual({ outcome: 'owner-unavailable' });
    expect(kill).toHaveBeenCalledWith(process.pid, 0);
    expect(h.spawnImpl).not.toHaveBeenCalled();
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('persists the exact child identity without credential contents', async () => {
    const dir = privateStoreDir();
    const h = harness();
    const run = refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps);
    const claim = JSON.parse(readFileSync(ownerPath(dir), 'utf8'));
    expect(claim).toEqual({
      version: 2, fence: expect.any(String), hostId: 'refresh-test-host',
      pid: 9000, processBirthToken: fixtureBirthToken(9000),
    });
    expect(lstatSync(ownerPath(dir)).mode & 0o777).toBe(0o600);
    h.children[0]!.emit('close', 0, null);
    await expect(run).resolves.toMatchObject({ outcome: 'ran', exitCode: 0 });
  });

  it.each(['absent', 'reused'] as const)('recovers after parent loss when the recorded child is %s without its close callback', async (state) => {
    const dir = privateStoreDir();
    const old = harness();
    vi.resetModules();
    const original = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    const abandoned = original.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, old.deps);
    await vi.advanceTimersByTimeAsync(REFRESH_AHEAD_WAIT_MS);
    await expect(abandoned).resolves.toEqual({ outcome: 'still-running' });
    const oldClaim = readFileSync(ownerPath(dir), 'utf8');

    // Only persisted state survives the parent. No close callback runs in it.
    vi.resetModules();
    const restarted = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    const successor = fakeChild(9001);
    const h = harness({
      spawnImpl: vi.fn(() => successor) as unknown as typeof import('node:child_process').spawn,
      inspectProcess: (pid) => pid === 9000 && state === 'absent'
        ? { state: 'absent' } : { state: 'alive', birthToken: fixtureBirthToken(9001) },
    });
    const next = restarted.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps);
    expect(h.deps.spawnImpl).toHaveBeenCalledOnce();
    expect(readFileSync(ownerPath(dir), 'utf8')).not.toBe(oldClaim);
    expect(JSON.parse(readFileSync(ownerPath(dir), 'utf8'))).toMatchObject({
      version: 2, pid: successor.pid, processBirthToken: fixtureBirthToken(successor.pid),
    });
    expect(old.children[0]!.kill).not.toHaveBeenCalled();
    successor.emit('close', 0, null);
    await expect(next).resolves.toMatchObject({ outcome: 'ran', exitCode: 0 });
  });

  it.each(['legacy', 'foreign-host', 'unknown-process', 'corrupt'] as const)(
    'preserves %s ownership but reports it as unavailable, not as a verified running child',
    async (kind) => {
      const dir = privateStoreDir();
      const claim = { version: 2, fence: 'prior-owner', hostId: 'refresh-test-host', pid: 9000, processBirthToken: fixtureBirthToken(9000) };
      const raw = kind === 'legacy' ? JSON.stringify({ version: 1, fence: 'prior-owner' })
        : kind === 'corrupt' ? '{invalid'
          : JSON.stringify({ ...claim, hostId: kind === 'foreign-host' ? 'different-host' : claim.hostId });
      const path = writeOwnerFixture(dir, raw);
      const before = claimFingerprint(path);
      const h = harness({
        fileStore: store(START.getTime() + 3_600_000),
        inspectProcess: () => kind === 'unknown-process' ? { state: 'unknown' } : { state: 'absent' },
      });
      await expect(refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps))
        .resolves.toEqual({ outcome: 'owner-unavailable' });
      expect(h.spawnImpl).not.toHaveBeenCalled();
      expect(h.readFileStore).not.toHaveBeenCalled();
      expect(readFileSync(path, 'utf8')).toBe(raw);
      expect(claimFingerprint(path)).toEqual(before);
    },
  );

  it('does not remove a successor claim that appears during dead-child inspection', async () => {
    const dir = privateStoreDir();
    const prior = { version: 2, fence: 'prior-owner', hostId: 'refresh-test-host', pid: 9000, processBirthToken: fixtureBirthToken(8000) };
    const replacement = JSON.stringify({ ...prior, fence: 'successor-owner', processBirthToken: 'successor-birth' });
    const path = writeOwnerFixture(dir, JSON.stringify(prior));
    const h = harness({ inspectProcess: () => {
      writeFileSync(path, replacement, { mode: 0o600 });
      return { state: 'absent' };
    } });
    await expect(refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps))
      .resolves.toEqual({ outcome: 'owner-unavailable' });
    expect(h.spawnImpl).not.toHaveBeenCalled();
    expect(h.readFileStore).not.toHaveBeenCalled();
    expect(readFileSync(path, 'utf8')).toBe(replacement);
  });
});

describe('refreshClaudeLoginAhead: never killed', () => {
  it.each([false, true])('a restarted parent defers an unobserved child even with renewed expiry: %s', async (renewed) => {
    const dir = privateStoreDir();
    const h = harness({ fileStore: store(START.getTime() + 1_000) });

    // Discarding module state represents a parent restart while its detached
    // child remains alive; only the store claim survives that boundary.
    vi.resetModules();
    const first = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    const firstRun = first.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps);
    await vi.advanceTimersByTimeAsync(first.REFRESH_AHEAD_WAIT_MS);
    await expect(firstRun).resolves.toEqual({ outcome: 'still-running' });
    expect(h.spawnImpl).toHaveBeenCalledOnce();

    vi.resetModules();
    const restarted = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    const successor = renewed
      ? harness({ fileStore: store(START.getTime() + 3_600_000) })
      : h;
    const afterRestart = restarted.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, successor.deps);
    await vi.advanceTimersByTimeAsync(restarted.REFRESH_AHEAD_WAIT_MS);
    await expect(afterRestart).resolves.toEqual({ outcome: 'still-running' });
    expect(h.spawnImpl).toHaveBeenCalledOnce();
    if (renewed) expect(successor.spawnImpl).not.toHaveBeenCalled();
    expect(h.children[0]!.kill).not.toHaveBeenCalled();
  });

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

  it('after the hard cap a hung child stops blocking the wait (one error line, ticker stopped), is never killed, and while it lives no second child starts', async () => {
    const dir = configDir();
    const h = harness({ fileStore: store(START.getTime() + 1_000) });
    void refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps);
    await vi.advanceTimersByTimeAsync(REFRESH_AHEAD_HARD_CAP_MS);
    const hungLines = () => h.lines.filter((l) => l.obj.event === 'claude_refresh_ahead_hung');
    expect(hungLines()).toHaveLength(1);
    expect(hungLines()[0]!.obj).toMatchObject({ purpose: 'refresh-ahead', pid: 9000, elapsedMs: REFRESH_AHEAD_HARD_CAP_MS });
    const ticks = h.lines.filter((l) => l.obj.event === 'claude_probe_still_running').length;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.lines.filter((l) => l.obj.event === 'claude_probe_still_running')).toHaveLength(ticks);
    expect(hungLines()).toHaveLength(1);
    expect(h.children[0]!.kill).not.toHaveBeenCalled();

    // Child A is still alive: a later caller is deferred at once and spawns nothing.
    let settled: unknown = 'pending';
    void refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps).then((r) => { settled = r; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toEqual({ outcome: 'still-running' });
    expect(h.spawnImpl).toHaveBeenCalledOnce();

    // Once A exits, a caller runs its own check again.
    h.children[0]!.emit('close', 0, null);
    const next = refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps);
    expect(h.spawnImpl).toHaveBeenCalledTimes(2);
    h.children[1]!.emit('close', 0, null);
    await expect(next).resolves.toMatchObject({ outcome: 'ran' });
  });

  it('unrefs the child so a hung refresh cannot keep the bot alive, while still awaiting its exit', async () => {
    const h = harness();
    const run = refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: configDir() }, h.deps);
    expect(h.children[0]!.unref).toHaveBeenCalledOnce();
    h.children[0]!.emit('close', 0, null);
    await expect(run).resolves.toMatchObject({ outcome: 'ran' });
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

describe('refreshClaudeLoginAhead: durable owner claim (proposed repair)', () => {
  it('uses one claim for canonical aliases and defers a fresh parent before renewed-expiry fast-path', async () => {
    const dir = privateStoreDir();
    const alias = join(dirname(dir), 'same-store-alias');
    symlinkSync(dir, alias, 'dir');
    const unrelatedConfig = join(dirname(dir), 'unrelated-config');
    const firstHarness = harness({ fileStore: store(START.getTime() + 1_000) });

    vi.resetModules();
    const first = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    const firstRun = first.refreshClaudeLoginAhead('claude', {
      CLAUDE_CONFIG_DIR: unrelatedConfig,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: dir,
    }, firstHarness.deps);
    await vi.advanceTimersByTimeAsync(first.REFRESH_AHEAD_WAIT_MS);
    await expect(firstRun).resolves.toEqual({ outcome: 'still-running' });
    expect(firstHarness.spawnImpl).toHaveBeenCalledOnce();

    const claim = ownerPath(dir);
    const raw = readFileSync(claim, 'utf8');
    expect(raw).not.toContain(ACCESS_SENTINEL);
    expect(raw).not.toContain(REFRESH_SENTINEL);
    expect(raw).not.toContain(dir);

    vi.resetModules();
    const restarted = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    const successor = harness({ fileStore: store(START.getTime() + 1_000) });
    const afterRestart = restarted.refreshClaudeLoginAhead('claude', {
      CLAUDE_CONFIG_DIR: unrelatedConfig,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: alias,
    }, successor.deps);
    await vi.advanceTimersByTimeAsync(restarted.REFRESH_AHEAD_WAIT_MS);
    await expect(afterRestart).resolves.toEqual({ outcome: 'still-running' });
    expect(successor.spawnImpl).not.toHaveBeenCalled();
    expect(firstHarness.children[0]!.kill).not.toHaveBeenCalled();
    firstHarness.children[0]!.emit('close', 0, null);
  });

  it('releases only its own claim on observed close, then permits a successor', async () => {
    const dir = privateStoreDir();
    const firstHarness = harness({ fileStore: store(START.getTime() + 1_000) });
    vi.resetModules();
    const first = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    const firstRun = first.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, firstHarness.deps);
    const claim = ownerPath(dir);
    expect(existsSync(claim)).toBe(true);

    firstHarness.children[0]!.emit('close', 0, null);
    await expect(firstRun).resolves.toMatchObject({ outcome: 'ran' });
    expect(existsSync(claim)).toBe(false);

    vi.resetModules();
    const successorModule = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    const successor = harness({ fileStore: store(START.getTime() + 1_000) });
    const next = successorModule.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, successor.deps);
    expect(successor.spawnImpl).toHaveBeenCalledOnce();
    successor.children[0]!.emit('close', 0, null);
    await expect(next).resolves.toMatchObject({ outcome: 'ran' });
    expect(firstHarness.children[0]!.kill).not.toHaveBeenCalled();
  });

  it('never deletes a foreign-fence replacement when its original child closes', async () => {
    const dir = privateStoreDir();
    const h = harness({ fileStore: store(START.getTime() + 1_000) });
    vi.resetModules();
    const refreshed = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    const run = refreshed.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps);
    const path = ownerPath(dir);
    const predecessor = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const foreignFence = 'foreign-fence-9b6428d1';
    writeFileSync(path, JSON.stringify({ ...predecessor, fence: foreignFence }), { mode: 0o600 });

    h.children[0]!.emit('close', 0, null);
    await expect(run).resolves.toEqual({ outcome: 'owner-unavailable' });
    expect(existsSync(path)).toBe(true);
    expect((JSON.parse(readFileSync(path, 'utf8')) as { fence?: unknown }).fence).toBe(foreignFence);
    expect(h.children[0]!.kill).not.toHaveBeenCalled();
  });

  it('defers the initiating caller when its owner claim disappears before close', async () => {
    const dir = privateStoreDir();
    const h = harness({ fileStore: store(START.getTime() + 1_000) });
    vi.resetModules();
    const refreshed = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    const run = refreshed.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps);
    const claim = ownerPath(dir);
    expect(existsSync(claim)).toBe(true);
    rmSync(claim);

    h.children[0]!.emit('close', 0, null);
    await expect(run).resolves.toEqual({ outcome: 'owner-unavailable' });
    expect(h.children[0]!.kill).not.toHaveBeenCalled();
  });

  it('keeps the fence after asynchronous error until close proves completion', async () => {
    const dir = privateStoreDir();
    const firstHarness = harness({ fileStore: store(START.getTime() + 1_000) });
    vi.resetModules();
    const first = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    const firstRun = first.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, firstHarness.deps);
    await vi.advanceTimersByTimeAsync(first.REFRESH_AHEAD_WAIT_MS);
    await expect(firstRun).resolves.toEqual({ outcome: 'still-running' });
    const claim = ownerPath(dir);
    const beforeError = readFileSync(claim, 'utf8');

    firstHarness.children[0]!.emit('error', new Error('status pipe ambiguity'));
    expect(readFileSync(claim, 'utf8')).toBe(beforeError);

    vi.resetModules();
    const restarted = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    const successor = harness({ fileStore: store(START.getTime() + 3_600_000) });
    const afterError = restarted.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, successor.deps);
    await vi.advanceTimersByTimeAsync(restarted.REFRESH_AHEAD_WAIT_MS);
    await expect(afterError).resolves.toEqual({ outcome: 'still-running' });
    expect(successor.spawnImpl).not.toHaveBeenCalled();
    firstHarness.children[0]!.emit('close', 1, null);
  });

  it('keeps the fence when an injected spawn throws synchronously, because launch outcome is ambiguous', async () => {
    const dir = privateStoreDir();
    const failedSpawn = vi.fn(() => { throw new Error('spawn transport failed'); }) as unknown as typeof import('node:child_process').spawn;
    const initial = harness({ fileStore: store(START.getTime() + 1_000), spawnImpl: failedSpawn });
    vi.resetModules();
    const first = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    await expect(first.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, initial.deps))
      .resolves.toEqual({ outcome: 'owner-unavailable' });
    const claim = ownerPath(dir);
    const raw = readFileSync(claim, 'utf8');
    expect(raw).not.toContain(ACCESS_SENTINEL);
    expect(raw).not.toContain(REFRESH_SENTINEL);

    vi.resetModules();
    const restarted = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    const successor = harness({ fileStore: store(START.getTime() + 3_600_000) });
    const later = restarted.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, successor.deps);
    await vi.advanceTimersByTimeAsync(restarted.REFRESH_AHEAD_WAIT_MS);
    await expect(later).resolves.toEqual({ outcome: 'owner-unavailable' });
    expect(successor.spawnImpl).not.toHaveBeenCalled();
  });

  it('releases its exact fence after a default native synchronous spawn validation throw so the next caller can recover', async () => {
    const dir = privateStoreDir();
    const savedVitest = process.env.VITEST;
    const savedNodeEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    try {
      vi.resetModules();
      const first = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
      await expect(first.refreshClaudeLoginAhead('claude\0invalid', { CLAUDE_CONFIG_DIR: dir }, {
        platform: 'linux',
        readFileStore: () => store(START.getTime() + 1_000),
      })).resolves.toEqual({ outcome: 'spawn-failed', reason: 'within-window' });
      expect(existsSync(ownerPath(dir))).toBe(false);

      vi.resetModules();
      const restarted = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
      const successor = harness({ fileStore: store(START.getTime() + 1_000) });
      const later = restarted.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, successor.deps);
      expect(successor.spawnImpl).toHaveBeenCalledOnce();
      successor.children[0]!.emit('close', 0, null);
      await expect(later).resolves.toEqual({ outcome: 'ran', reason: 'within-window', exitCode: 0, signal: null });
    } finally {
      if (savedVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = savedVitest;
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNodeEnv;
    }
  });

  it('reports a pidless child error without close as unavailable and retains its claim', async () => {
    const dir = privateStoreDir();
    const child = fakeChild(9000);
    Object.defineProperty(child, 'pid', { value: undefined, writable: true });
    const spawnImpl = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const initial = harness({ fileStore: store(START.getTime() + 1_000), spawnImpl });
    vi.resetModules();
    const first = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    const run = first.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, initial.deps);

    child.emit('error', new Error('status pipe ambiguity'));
    await vi.advanceTimersByTimeAsync(first.REFRESH_AHEAD_WAIT_MS);
    await expect(run).resolves.toEqual({ outcome: 'owner-unavailable' });
    expect(existsSync(ownerPath(dir))).toBe(true);
  });

  it('reports unavailable for a pidless child and releases only its own claim after close', async () => {
    const dir = privateStoreDir();
    const child = fakeChild(9001);
    Object.defineProperty(child, 'pid', { value: undefined });
    const spawnImpl = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const h = harness({ fileStore: store(START.getTime() + 1_000), spawnImpl });
    const run = refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps);
    child.emit('error', new Error('spawn failed'));
    expect(existsSync(ownerPath(dir))).toBe(true);
    child.emit('close', -2, null);
    await expect(run).resolves.toEqual({ outcome: 'owner-unavailable' });
    expect(existsSync(ownerPath(dir))).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('reports an owner-directory EACCES without spawning a refresh child', async () => {
    const dir = privateStoreDir();
    const h = harness({ fileStore: store(START.getTime() + 1_000) });
    const directory = dirname(ownerPath(dir));
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.doMock('node:fs', () => ({
      ...actualFs,
      mkdirSync: (...args: Parameters<typeof actualFs.mkdirSync>) => {
        if (args[0] === directory) {
          const error = new Error('injected EACCES') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return actualFs.mkdirSync(...args);
      },
    }));
    vi.resetModules();
    const refreshed = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    await expect(refreshed.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps))
      .resolves.toEqual({ outcome: 'owner-unavailable' });
    expect(h.spawnImpl).not.toHaveBeenCalled();
    expect(existsSync(ownerPath(dir))).toBe(false);
  });

  it.each(['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'] as const)(
    'initializes an absent final %s leaf before coordinating a refresh', async (selector) => {
      const h = harness({ fileStore: store(START.getTime() + 1_000) });
      const missing = join(privateStoreDir(), 'fresh-store');
      const env = { CLAUDE_CONFIG_DIR: privateStoreDir(), [selector]: missing };
      const run = refreshClaudeLoginAhead('claude', env, h.deps);
      expect(h.spawnImpl).toHaveBeenCalledOnce();
      expect(lstatSync(missing).isDirectory()).toBe(true);
      expect(lstatSync(missing).mode & 0o777).toBe(0o700);
      expect(existsSync(ownerPath(missing))).toBe(true);
      const concurrent = refreshClaudeLoginAhead('claude', env, h.deps);
      expect(h.spawnImpl).toHaveBeenCalledOnce();
      h.children[0]!.emit('close', 0, null);
      const expected = { outcome: 'ran', reason: 'within-window', exitCode: 0, signal: null };
      await expect(run).resolves.toEqual(expected);
      await expect(concurrent).resolves.toEqual(expected);
      expect(existsSync(ownerPath(missing))).toBe(false);
      expect(h.children[0]!.kill).not.toHaveBeenCalled();
    },
  );

  it('does not create a missing intermediate store directory or spawn a refresh', async () => {
    const h = harness({ fileStore: store(START.getTime() + 1_000) });
    const intermediate = join(privateStoreDir(), 'missing-parent');
    const missing = join(intermediate, 'missing-store');
    vi.resetModules();
    const refreshed = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    await expect(refreshed.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: missing }, h.deps))
      .resolves.toEqual({ outcome: 'owner-unavailable' });
    expect(h.spawnImpl).not.toHaveBeenCalled();
    expect(existsSync(intermediate)).toBe(false);
  });

  it('does not initialize a dangling store symlink or its missing target', async () => {
    const h = harness({ fileStore: store(START.getTime() + 1_000) });
    const parent = privateStoreDir();
    const missing = join(parent, 'missing-store');
    const target = join(parent, 'missing-target');
    symlinkSync(target, missing);
    await expect(refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: missing }, h.deps))
      .resolves.toEqual({ outcome: 'owner-unavailable' });
    expect(h.spawnImpl).not.toHaveBeenCalled();
    expect(lstatSync(missing).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it.each(['denied', 'symlink', 'parent-replaced'] as const)(
    'refuses %s during final store initialization before reading credentials', async (failure) => {
      const h = harness({ fileStore: store(START.getTime() + 1_000) });
      const parent = privateStoreDir();
      const missing = join(parent, 'fresh-store');
      const other = privateStoreDir();
      const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
      vi.doMock('node:fs', () => ({
        ...actualFs,
        mkdirSync: (...args: Parameters<typeof actualFs.mkdirSync>) => {
          if (args[0] === missing) {
            if (failure === 'parent-replaced') {
              actualFs.renameSync(parent, `${parent}-original`);
              actualFs.mkdirSync(parent, { mode: 0o700 });
              return actualFs.mkdirSync(...args);
            }
            if (failure === 'symlink') actualFs.symlinkSync(other, missing);
            const error = new Error('injected store initialization race') as NodeJS.ErrnoException;
            error.code = failure === 'denied' ? 'EACCES' : 'EEXIST';
            throw error;
          }
          return actualFs.mkdirSync(...args);
        },
      }));
      vi.resetModules();
      const refreshed = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
      await expect(refreshed.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: missing }, h.deps))
        .resolves.toEqual({ outcome: 'owner-unavailable' });
      expect(h.spawnImpl).not.toHaveBeenCalled();
      expect(h.readFileStore).not.toHaveBeenCalled();
      expect(existsSync(ownerPath(missing))).toBe(false);
      expect(existsSync(ownerPath(other))).toBe(false);
      if (failure === 'denied') expect(existsSync(missing)).toBe(false);
      if (failure === 'symlink') expect(lstatSync(missing).isSymbolicLink()).toBe(true);
      if (failure === 'parent-replaced') {
        expect(existsSync(`${parent}-original`)).toBe(true);
        // Path-based initialization may leave an empty leaf after a same-UID exchange.
        expect(actualFs.readdirSync(missing)).toEqual([]);
      }
    },
  );

  it.each([0o770, 0o707])('refuses a missing store under a writable-by-others parent (%o)', async (mode) => {
    const h = harness({ fileStore: store(START.getTime() + 1_000) });
    const parent = privateStoreDir();
    chmodSync(parent, mode);
    const missing = join(parent, 'fresh-store');
    await expect(refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: missing }, h.deps))
      .resolves.toEqual({ outcome: 'owner-unavailable' });
    expect(existsSync(missing)).toBe(false);
    expect(h.readFileStore).not.toHaveBeenCalled();
    expect(h.spawnImpl).not.toHaveBeenCalled();
  });

  it('initializes a private store under a conventional current-user 0755 parent', async () => {
    const h = harness({ fileStore: store(START.getTime() + 1_000) });
    const parent = privateStoreDir();
    chmodSync(parent, 0o755);
    const missing = join(parent, 'fresh-store');
    const run = refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: missing }, h.deps);
    expect(h.spawnImpl).toHaveBeenCalledOnce();
    expect(lstatSync(parent).mode & 0o777).toBe(0o755);
    expect(lstatSync(missing).mode & 0o777).toBe(0o700);
    h.children[0]!.emit('close', 0, null);
    await expect(run).resolves.toEqual({ outcome: 'ran', reason: 'within-window', exitCode: 0, signal: null });
  });

  it('refuses a private parent beneath a writable non-sticky ancestor before creating the leaf', async () => {
    const h = harness({ fileStore: store(START.getTime() + 1_000) });
    const ancestor = privateStoreDir();
    const parent = join(ancestor, 'private-parent');
    mkdirSync(parent, { mode: 0o700 });
    chmodSync(ancestor, 0o777);
    const missing = join(parent, 'fresh-store');
    await expect(refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: missing }, h.deps))
      .resolves.toEqual({ outcome: 'owner-unavailable' });
    expect(existsSync(missing)).toBe(false);
    expect(h.readFileStore).not.toHaveBeenCalled();
    expect(h.spawnImpl).not.toHaveBeenCalled();
  });

  it('accepts a concurrently initialized private store and still claims its refresh', async () => {
    const h = harness({ fileStore: store(START.getTime() + 1_000) });
    const missing = join(privateStoreDir(), 'fresh-store');
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.doMock('node:fs', () => ({
      ...actualFs,
      mkdirSync: (...args: Parameters<typeof actualFs.mkdirSync>) => {
        if (args[0] === missing) {
          actualFs.mkdirSync(missing, { mode: 0o700 });
          const error = new Error('another process created the directory') as NodeJS.ErrnoException;
          error.code = 'EEXIST';
          throw error;
        }
        return actualFs.mkdirSync(...args);
      },
    }));
    vi.resetModules();
    const refreshed = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    const run = refreshed.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: missing }, h.deps);
    expect(h.spawnImpl).toHaveBeenCalledOnce();
    expect(existsSync(ownerPath(missing))).toBe(true);
    h.children[0]!.emit('close', 0, null);
    await expect(run).resolves.toEqual({ outcome: 'ran', reason: 'within-window', exitCode: 0, signal: null });
    expect(existsSync(ownerPath(missing))).toBe(false);
  });

  it.each([
    ['invalid', 'owner-unavailable'],
    ['corrupt', 'owner-unavailable'],
    ['symlink', 'owner-unavailable'],
    ['hardlink', 'owner-unavailable'],
    ['wrong-mode', 'owner-unavailable'],
    ['oversize', 'owner-unavailable'],
  ] as const)(
    'leaves a %s claim untouched and defers before renewed-expiry fast path with %s',
    async (kind, outcome) => {
      const dir = privateStoreDir();
      const path = ownerPath(dir);
      const target = join(dirname(path), `${kind}-target`);
      if (kind === 'invalid') writeOwnerFixture(dir, '{}');
      if (kind === 'corrupt') writeOwnerFixture(dir, '{not-json');
      if (kind === 'symlink') {
        writeOwnerFixture(dir);
        rmSync(path);
        writeFileSync(target, 'untrusted-owner-claim', { mode: 0o600 });
        symlinkSync(target, path);
      }
      if (kind === 'hardlink') {
        writeOwnerFixture(dir);
        rmSync(path);
        writeFileSync(target, 'untrusted-owner-claim', { mode: 0o600 });
        linkSync(target, path);
      }
      if (kind === 'wrong-mode') {
        writeOwnerFixture(dir);
        chmodSync(path, 0o644);
      }
      if (kind === 'oversize') writeOwnerFixture(dir, 'x'.repeat(OWNER_MAX_BYTES + 1));

      const before = claimFingerprint(path);
      const beforeBytes = kind === 'symlink' ? readFileSync(target, 'utf8') : readFileSync(path, 'utf8');
      vi.resetModules();
      const refreshed = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
      const h = harness({ fileStore: store(START.getTime() + 3_600_000) });
      const result = refreshed.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps);
      await vi.advanceTimersByTimeAsync(refreshed.REFRESH_AHEAD_WAIT_MS);
      await expect(result).resolves.toEqual({ outcome });
      expect(h.spawnImpl).not.toHaveBeenCalled();
      expect(claimFingerprint(path)).toEqual(before);
      expect(kind === 'symlink' ? readFileSync(target, 'utf8') : readFileSync(path, 'utf8')).toBe(beforeBytes);
    },
  );

  it('defers a wrong-owner claim without deleting it', async () => {
    const dir = privateStoreDir();
    const path = writeOwnerFixture(dir);
    const before = claimFingerprint(path);
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.doMock('node:fs', () => ({
      ...actualFs,
      lstatSync: (...args: Parameters<typeof actualFs.lstatSync>) => {
        const state = actualFs.lstatSync(...args);
        if (args[0] !== path || state === undefined) return state;
        const uid = typeof state.uid === 'bigint' ? state.uid + 1n : state.uid + 1;
        return Object.create(state, { uid: { value: uid } });
      },
    }));
    vi.resetModules();
    const refreshed = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    const h = harness({ fileStore: store(START.getTime() + 3_600_000) });
    const result = refreshed.refreshClaudeLoginAhead('claude', { CLAUDE_CONFIG_DIR: dir }, h.deps);
    await vi.advanceTimersByTimeAsync(refreshed.REFRESH_AHEAD_WAIT_MS);
    await expect(result).resolves.toEqual({ outcome: 'owner-unavailable' });
    expect(h.spawnImpl).not.toHaveBeenCalled();
    expect(claimFingerprint(path)).toEqual(before);
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

  it('a kill that returns false is not reported as a kill', async () => {
    const child = fakeChild(4105);
    child.kill = vi.fn(() => false);
    const spawnImpl = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const exits: unknown[] = [];
    void probeBinaryCommand('claude', ['-p', 'x'], {}, { timeoutMs: 15_000, onExited: (exit) => { exits.push(exit); } }, spawnImpl);
    await vi.advanceTimersByTimeAsync(17_000);
    expect(child.kill).toHaveBeenCalled();
    child.emit('close', 0, null);
    expect(exits).toEqual([expect.objectContaining({ killedByTimeout: false, killedByAbort: false })]);
  });

  it('signals at once when no grace applies', async () => {
    const child = fakeChild(4102);
    const spawnImpl = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    void probeBinaryCommand('claude', ['-p', 'x'], {}, { timeoutMs: 15_000, terminationGrace: () => null }, spawnImpl);
    vi.advanceTimersByTime(15_000);
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
describe('refreshClaudeLoginAhead: shutdown drain admission and close join', () => {
  it('closes process-lifetime refresh admission even after an empty snapshot, so a different secure store creates neither owner nor child', async () => {
    vi.resetModules();
    const refreshed = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    await expect(refreshed.awaitActiveClaudeRefreshes(Date.now() + 1_000)).resolves.toBeUndefined();

    const deniedStore = privateStoreDir();
    const denied = harness({ fileStore: store(START.getTime() + 1_000) });
    const attempt = refreshed.refreshClaudeLoginAhead('claude', {
      CLAUDE_SECURESTORAGE_CONFIG_DIR: deniedStore,
    }, denied.deps);

    expect(denied.spawnImpl).not.toHaveBeenCalled();
    expect(denied.readFileStore).not.toHaveBeenCalled();
    await expect(attempt).resolves.toEqual({ outcome: 'owner-unavailable' });
    expect(existsSync(ownerPath(deniedStore))).toBe(false);
  });

  it('keeps a pidless error child pending until close, then reports a typed shutdown deadline without signalling it', async () => {
    const dir = privateStoreDir();
    const child = fakeChild(9000);
    Object.defineProperty(child, 'pid', { value: undefined, writable: true });
    const initial = harness({
      fileStore: store(START.getTime() + 1_000),
      spawnImpl: vi.fn(() => child) as unknown as typeof import('node:child_process').spawn,
    });
    vi.resetModules();
    const refreshed = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');
    const run = refreshed.refreshClaudeLoginAhead('claude', {
      CLAUDE_SECURESTORAGE_CONFIG_DIR: dir,
    }, initial.deps);

    child.emit('error', new Error('pidless launch observation'));
    await expect(run).resolves.toEqual({ outcome: 'owner-unavailable' });
    expect(existsSync(ownerPath(dir))).toBe(true);

    const drain = refreshed.awaitActiveClaudeRefreshes(Date.now() + 1);
    const rejected = expect(drain).rejects.toBeInstanceOf(refreshed.ClaudeRefreshShutdownDeadlineError);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(existsSync(ownerPath(dir))).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();

    child.emit('close', -1, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(existsSync(ownerPath(dir))).toBe(false);
  });

  it('joins a real native child past hard cap until close, never signalling it', async () => {
    const { native, ended } = await nativeChildHeldUntilEof();
    const nativeKill = vi.spyOn(native, 'kill');
    const dir = privateStoreDir();
    const initial = harness({
      fileStore: store(START.getTime() + 1_000),
      hostId: hostname(),
      inspectProcess: undefined,
      spawnImpl: (() => native) as unknown as typeof import('node:child_process').spawn,
    });
    vi.resetModules();
    const refreshed = await import('../../../../src/runtimes/agent/providers/claude-refresh-ahead.ts');

    try {
      const run = refreshed.refreshClaudeLoginAhead('claude', {
        CLAUDE_SECURESTORAGE_CONFIG_DIR: dir,
      }, initial.deps);
      await vi.advanceTimersByTimeAsync(refreshed.REFRESH_AHEAD_WAIT_MS);
      await expect(run).resolves.toEqual({ outcome: 'still-running' });
      await vi.advanceTimersByTimeAsync(refreshed.REFRESH_AHEAD_HARD_CAP_MS - refreshed.REFRESH_AHEAD_WAIT_MS);

      const drain = refreshed.awaitActiveClaudeRefreshes(Date.now() + 1_000);
      let settled = false;
      void drain.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(native.exitCode).toBeNull();
      expect(nativeKill).not.toHaveBeenCalled();

      const deniedStore = privateStoreDir();
      const denied = harness({ fileStore: store(START.getTime() + 1_000) });
      const attempt = refreshed.refreshClaudeLoginAhead('claude', {
        CLAUDE_SECURESTORAGE_CONFIG_DIR: deniedStore,
      }, denied.deps);
      expect(denied.spawnImpl).not.toHaveBeenCalled();
      expect(denied.readFileStore).not.toHaveBeenCalled();
      await expect(attempt).resolves.toEqual({ outcome: 'owner-unavailable' });
      expect(existsSync(ownerPath(deniedStore))).toBe(false);
      expect(settled).toBe(false);

      native.stdin!.end();
      await ended;
      await expect(drain).resolves.toBeUndefined();
      expect(nativeKill).not.toHaveBeenCalled();
    } finally {
      if (native.exitCode === null) native.stdin!.end();
      await ended;
    }
  });
});
