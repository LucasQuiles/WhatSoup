// Refresh-ahead wiring into the killable non-turn `claude` probes: the
// primary-model probe, the account-identity probe and the diagnostic bundle's
// auth-status probe. The refresh-ahead child runs before the probe's budget is
// armed, so a slow refresh can never make the probe time out, and it is never
// killed. The probes' own kill waits while the CLI's refresh lock is held.
// Fake children and credentials; owner claims use a private temporary directory.
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrimaryModelProbeAdapters, type PrimaryModelProbeAdapterDeps } from '../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts';
import { probePrimaryModelUsability } from '../../../src/runtimes/agent/providers/primary-model-usability.ts';
import { probeBinaryCommand } from '../../../src/runtimes/agent/providers/binary-preflight.ts';
import { REFRESH_AHEAD_WAIT_MS, refreshClaudeLoginAhead } from '../../../src/runtimes/agent/providers/claude-refresh-ahead.ts';
import { primaryModelUsabilityRequiresAlert } from '../../../src/runtimes/agent/providers/primary-model-usability.ts';
import { observeClaudeAccountIdentity } from '../../../src/runtimes/agent/providers/claude-account-identity.ts';
import { makeAccountAuthStatusProbe, type AccountAuthStatusDeps } from '../../../src/runtimes/agent/providers/account-auth-status.ts';

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

function spawnRecorder() {
  const children: FakeChild[] = [];
  const calls: Array<{ args: string[]; at: number }> = [];
  const spawnImpl = vi.fn((_binary: string, args: string[]) => {
    const child = fakeChild(7000 + children.length);
    children.push(child);
    calls.push({ args, at: Date.now() });
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  return { children, calls, spawnImpl };
}

const quietLog = { info: () => undefined, warn: () => undefined, error: () => undefined };
const START = new Date('2026-10-19T09:00:00.000Z');
let savedConfigDir: string | undefined;
let savedSecureStorageDir: string | undefined;
let fixtureRoot: string;

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  savedSecureStorageDir = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  fixtureRoot = mkdtempSync(join(tmpdir(), 'refresh-ahead-wiring-'));
  const store = join(fixtureRoot, '.claude');
  mkdirSync(store, { mode: 0o700 });
  process.env.CLAUDE_CONFIG_DIR = store;
  process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = store;
});
afterEach(() => {
  vi.useRealTimers();
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  if (savedSecureStorageDir === undefined) delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  else process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = savedSecureStorageDir;
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function adapterDeps(probeSpawn: typeof import('node:child_process').spawn, over: Partial<PrimaryModelProbeAdapterDeps> = {}): PrimaryModelProbeAdapterDeps {
  return {
    getProviderBinary: () => 'claude',
    ensureClaudeFileStoreCredential: () => ({ outcome: 'skipped-cli-reads-own-item' }),
    probeBinaryCommand: (binary, args, env, options) => probeBinaryCommand(binary, args, env, options, probeSpawn),
    claudeRefreshLockGrace: () => null,
    log: quietLog,
    ...over,
  };
}

describe('primary-model probe: refresh-ahead runs before the probe budget', () => {
  it('a refresh-ahead slower than the 15 s budget does not make the probe time out', async () => {
    const probe = spawnRecorder();
    let finishRefresh!: () => void;
    const refreshAhead = vi.fn(() => new Promise<void>((resolve) => { finishRefresh = resolve; }));
    const result = probePrimaryModelUsability(
      { provider: 'claude-cli', model: null },
      createPrimaryModelProbeAdapters(undefined, adapterDeps(probe.spawnImpl, { refreshClaudeLoginAhead: refreshAhead })),
    );

    // The refresh-ahead takes 40 s, far past the 15 s budget.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(refreshAhead).toHaveBeenCalledOnce();
    expect(probe.spawnImpl).not.toHaveBeenCalled();
    finishRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(probe.spawnImpl).toHaveBeenCalledOnce();

    // The probe's whole budget is still ahead of it: answer at 14 s.
    await vi.advanceTimersByTimeAsync(14_000);
    probe.children[0]!.emit('close', 0, null);
    await expect(result).resolves.toMatchObject({ status: 'usable' });
    expect(probe.children[0]!.kill).not.toHaveBeenCalled();
  });

  it('the real refresh-ahead child outlives the probe budget and is never signalled', async () => {
    const refresh = spawnRecorder();
    const probe = spawnRecorder();
    const result = probePrimaryModelUsability(
      { provider: 'claude-cli', model: null },
      createPrimaryModelProbeAdapters(undefined, adapterDeps(probe.spawnImpl, {
        refreshClaudeLoginAhead: (binary, env) => refreshClaudeLoginAhead(binary, env, {
          platform: 'linux',
          readFileStore: () => null,
          spawnImpl: refresh.spawnImpl,
          log: quietLog,
        }),
      })),
    );

    await vi.advanceTimersByTimeAsync(50_000);
    expect(refresh.calls.map((c) => c.args)).toEqual([['auth', 'status', '--json']]);
    expect(refresh.children[0]!.kill).not.toHaveBeenCalled();
    expect(probe.spawnImpl).not.toHaveBeenCalled();

    refresh.children[0]!.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(probe.spawnImpl).toHaveBeenCalledOnce();
    probe.children[0]!.emit('close', 0, null);
    await expect(result).resolves.toMatchObject({ status: 'usable' });
    expect(refresh.children[0]!.kill).not.toHaveBeenCalled();
  });

  it('a refresh-ahead child still running after the wait defers the probe: no killable child, inconclusive, no alert', async () => {
    const refresh = spawnRecorder();
    const probe = spawnRecorder();
    const result = probePrimaryModelUsability(
      { provider: 'claude-cli', model: null },
      createPrimaryModelProbeAdapters(undefined, adapterDeps(probe.spawnImpl, {
        refreshClaudeLoginAhead: (binary, env) => refreshClaudeLoginAhead(binary, env, {
          platform: 'linux',
          readFileStore: () => null,
          spawnImpl: refresh.spawnImpl,
          log: quietLog,
        }),
      })),
    );
    await vi.advanceTimersByTimeAsync(REFRESH_AHEAD_WAIT_MS);
    const settled = await result;
    expect(settled).toMatchObject({ status: 'unknown', reason: 'deferred-refresh-in-flight' });
    expect(primaryModelUsabilityRequiresAlert(settled)).toBe(false);
    expect(probe.spawnImpl).not.toHaveBeenCalled();
    expect(refresh.children[0]!.kill).not.toHaveBeenCalled();
    refresh.children[0]!.emit('close', 0, null);
  });

  it('an unavailable refresh owner defers the primary probe but requires an alert', async () => {
    const probe = spawnRecorder();
    const probeBinaryCommand = vi.fn(async () => ({ status: 'ok' as const, output: 'OK' }));
    const result = await probePrimaryModelUsability(
      { provider: 'claude-cli', model: null },
      createPrimaryModelProbeAdapters(undefined, adapterDeps(probe.spawnImpl, {
        refreshClaudeLoginAhead: async () => ({ outcome: 'owner-unavailable' }),
        probeBinaryCommand,
      })),
    );
    expect(result).toMatchObject({ status: 'unknown', reason: 'refresh-owner-unavailable' });
    expect(primaryModelUsabilityRequiresAlert(result)).toBe(true);
    expect(probeBinaryCommand).not.toHaveBeenCalled();
    expect(probe.spawnImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['spawn-failed', { outcome: 'spawn-failed', reason: 'within-window' }],
    ['nonzero exit', { outcome: 'ran', reason: 'within-window', exitCode: 1, signal: null }],
    ['signal exit', { outcome: 'ran', reason: 'within-window', exitCode: null, signal: 'SIGTERM' }],
  ])('a completed refresh with %s defers the primary probe and requires an alert', async (_label, refreshed) => {
    const probe = spawnRecorder();
    const probeBinaryCommand = vi.fn(async () => ({ status: 'ok' as const, output: 'OK' }));
    const result = await probePrimaryModelUsability(
      { provider: 'claude-cli', model: null },
      createPrimaryModelProbeAdapters(undefined, adapterDeps(probe.spawnImpl, {
        refreshClaudeLoginAhead: async () => refreshed,
        probeBinaryCommand,
      })),
    );
    expect(result).toMatchObject({ status: 'unknown', reason: 'refresh-failed' });
    expect(primaryModelUsabilityRequiresAlert(result)).toBe(true);
    expect(probeBinaryCommand).not.toHaveBeenCalled();
    expect(probe.spawnImpl).not.toHaveBeenCalled();
  });

  it('a thrown refresh defers the primary probe and requires an alert', async () => {
    const probe = spawnRecorder();
    const probeBinaryCommand = vi.fn(async () => ({ status: 'ok' as const, output: 'OK' }));
    const result = await probePrimaryModelUsability(
      { provider: 'claude-cli', model: null },
      createPrimaryModelProbeAdapters(undefined, adapterDeps(probe.spawnImpl, {
        refreshClaudeLoginAhead: async () => { throw new Error('refresh transport failed'); },
        probeBinaryCommand,
      })),
    );
    expect(result).toMatchObject({ status: 'unknown', reason: 'refresh-failed' });
    expect(primaryModelUsabilityRequiresAlert(result)).toBe(true);
    expect(probeBinaryCommand).not.toHaveBeenCalled();
    expect(probe.spawnImpl).not.toHaveBeenCalled();
  });

  it('a caller that cancelled during the refresh wait gets its cancellation, not the deferral', async () => {
    const probe = spawnRecorder();
    const controller = new AbortController();
    const result = await probePrimaryModelUsability(
      { provider: 'claude-cli', model: null },
      createPrimaryModelProbeAdapters(undefined, adapterDeps(probe.spawnImpl, {
        refreshClaudeLoginAhead: async () => { controller.abort(); return { outcome: 'still-running' }; },
      })),
      { signal: controller.signal },
    );
    expect(result).toMatchObject({ status: 'timeout', reason: 'caller-pre-aborted' });
    expect(probe.spawnImpl).not.toHaveBeenCalled();
  });

  it('is not run for a provider other than claude-cli', async () => {
    const probe = spawnRecorder();
    const refreshAhead = vi.fn(async () => undefined);
    const result = probePrimaryModelUsability(
      { provider: 'opencode-cli', model: 'zai/glm-5' },
      createPrimaryModelProbeAdapters(undefined, adapterDeps(probe.spawnImpl, {
        getProviderBinary: () => 'opencode',
        buildChildEnv: () => ({}),
        refreshClaudeLoginAhead: refreshAhead,
      })),
    );
    await vi.advanceTimersByTimeAsync(0);
    probe.children[0]?.emit('close', 0, null);
    await result;
    expect(refreshAhead).not.toHaveBeenCalled();
  });

  it('the deadline kill waits while the refresh lock is held', async () => {
    const probe = spawnRecorder();
    let release!: () => void;
    const grace = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const result = probePrimaryModelUsability(
      { provider: 'claude-cli', model: null },
      createPrimaryModelProbeAdapters(undefined, adapterDeps(probe.spawnImpl, {
        refreshClaudeLoginAhead: async () => undefined,
        claudeRefreshLockGrace: grace,
      })),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(grace).toHaveBeenCalledOnce();
    expect(probe.children[0]!.kill).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(probe.children[0]!.kill).toHaveBeenCalledOnce();
    probe.children[0]!.emit('close', null, 'SIGTERM');
    await expect(result).resolves.toMatchObject({ status: 'timeout' });
  });
});

describe('account-identity probe', () => {
  it('runs refresh-ahead before its auth status probe and arms the lock grace on the probe', async () => {
    const order: string[] = [];
    const probeOptions: unknown[] = [];
    const observed = await observeClaudeAccountIdentity({
      getProviderBinary: () => 'claude',
      env: { CLAUDE_CONFIG_DIR: '/tmp/identity-fixture/.claude' },
      refreshClaudeLoginAhead: async () => { order.push('refresh-ahead'); },
      claudeRefreshLockGrace: () => null,
      probeBinaryCommand: async (_binary, _args, _env, options) => {
        order.push('probe');
        probeOptions.push(options);
        return { status: 'failed', output: '' };
      },
    });
    expect(observed).toEqual({ kind: 'failed', reason: 'probe-failed' });
    expect(order).toEqual(['refresh-ahead', 'probe']);
    expect(typeof (probeOptions[0] as { terminationGrace?: unknown }).terminationGrace).toBe('function');
  });
});

describe('account-identity probe deferral', () => {
  it('reports unavailable refresh ownership without starting its killable probe', async () => {
    const probeBinaryCommandSpy = vi.fn(async () => ({ status: 'ok' as const, output: '{}' }));
    const observed = await observeClaudeAccountIdentity({
      getProviderBinary: () => 'claude',
      env: { CLAUDE_CONFIG_DIR: '/tmp/identity-fixture/.claude' },
      refreshClaudeLoginAhead: async () => ({ outcome: 'owner-unavailable' }),
      claudeRefreshLockGrace: () => null,
      probeBinaryCommand: probeBinaryCommandSpy,
    });
    expect(observed).toEqual({ kind: 'failed', reason: 'refresh-owner-unavailable' });
    expect(probeBinaryCommandSpy).not.toHaveBeenCalled();
  });

  it('reports a thrown refresh without starting its killable probe', async () => {
    const probeBinaryCommandSpy = vi.fn(async () => ({ status: 'ok' as const, output: '{}' }));
    const observed = await observeClaudeAccountIdentity({
      getProviderBinary: () => 'claude',
      env: { CLAUDE_CONFIG_DIR: '/tmp/identity-fixture/.claude' },
      refreshClaudeLoginAhead: async () => { throw new Error('owner publication unavailable'); },
      claudeRefreshLockGrace: () => null,
      probeBinaryCommand: probeBinaryCommandSpy,
    });
    expect(observed).toEqual({ kind: 'failed', reason: 'refresh-failed' });
    expect(probeBinaryCommandSpy).not.toHaveBeenCalled();
  });

  it('does not start its killable probe while the refresh-ahead child still runs', async () => {
    const probeBinaryCommandSpy = vi.fn(async () => ({ status: 'ok' as const, output: '{}' }));
    const observed = await observeClaudeAccountIdentity({
      getProviderBinary: () => 'claude',
      env: { CLAUDE_CONFIG_DIR: '/tmp/identity-fixture/.claude' },
      refreshClaudeLoginAhead: async () => ({ outcome: 'still-running' }),
      claudeRefreshLockGrace: () => null,
      probeBinaryCommand: probeBinaryCommandSpy,
    });
    expect(observed).toEqual({ kind: 'failed', reason: 'deferred-refresh-in-flight' });
    expect(probeBinaryCommandSpy).not.toHaveBeenCalled();
  });
});

describe('diagnostic auth-status probe', () => {
  it('reports the abort, not the deferral, when the bundle gave up during the refresh wait', async () => {
    const controller = new AbortController();
    const deps = authDeps({ refreshAhead: async () => { controller.abort(); return { outcome: 'still-running' }; } });
    const result = await makeAccountAuthStatusProbe({ provider: 'claude-cli' }, deps)(controller.signal);
    expect(deps.probeBinaryAuthStatus).not.toHaveBeenCalled();
    expect(result.summary).toContain('aborted');
  });

  it('does not start its killable spawn while the refresh-ahead child still runs', async () => {
    const deps = authDeps({ refreshAhead: async () => ({ outcome: 'still-running' }) });
    const result = await makeAccountAuthStatusProbe({ provider: 'claude-cli' }, deps)(new AbortController().signal);
    expect(deps.probeBinaryAuthStatus).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, confidence: 'suspected' });
  });

  it('reports unavailable refresh ownership without starting its killable spawn', async () => {
    const deps = authDeps({ refreshAhead: async () => ({ outcome: 'owner-unavailable' }) });
    const result = await makeAccountAuthStatusProbe({ provider: 'claude-cli' }, deps)(new AbortController().signal);
    expect(deps.probeBinaryAuthStatus).not.toHaveBeenCalled();
    expect(result.summary).toContain('refresh ownership unavailable');
  });

  it('reports a thrown refresh without starting its killable spawn', async () => {
    const deps = authDeps({ refreshAhead: async () => { throw new Error('owner publication unavailable'); } });
    const result = await makeAccountAuthStatusProbe({ provider: 'claude-cli' }, deps)(new AbortController().signal);
    expect(deps.probeBinaryAuthStatus).not.toHaveBeenCalled();
    expect(result.summary).toContain('login refresh failed');
  });

  function authDeps(over: Partial<AccountAuthStatusDeps> = {}): AccountAuthStatusDeps {
    return {
      resolveKeyService: () => null,
      lookupCredential: () => null,
      getProviderBinary: () => 'claude',
      probeBinaryAuthStatus: vi.fn(async () => ({ status: 'ok' as const, output: '{"loggedIn":true}' })),
      isAuthRequiredMessage: () => false,
      env: { CLAUDE_CONFIG_DIR: '/tmp/diagnostic-fixture/.claude' },
      ...over,
    };
  }

  it('runs refresh-ahead before the auth status spawn for claude-cli', async () => {
    const order: string[] = [];
    const deps = authDeps({
      refreshAhead: async () => { order.push('refresh-ahead'); },
      probeBinaryAuthStatus: async () => { order.push('probe'); return { status: 'ok', output: '{}' }; },
    });
    await makeAccountAuthStatusProbe({ provider: 'claude-cli' }, deps)(new AbortController().signal);
    expect(order).toEqual(['refresh-ahead', 'probe']);
  });

  it('skips the killable spawn when the bundle gave up during refresh-ahead', async () => {
    const controller = new AbortController();
    const deps = authDeps({ refreshAhead: async () => { controller.abort(); } });
    const result = await makeAccountAuthStatusProbe({ provider: 'claude-cli' }, deps)(controller.signal);
    expect(deps.probeBinaryAuthStatus).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, confidence: 'suspected' });
  });
});
