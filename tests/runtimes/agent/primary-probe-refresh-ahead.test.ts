// Refresh-ahead wiring into the killable non-turn `claude` probes: the
// primary-model probe, the account-identity probe and the diagnostic bundle's
// auth-status probe. The refresh-ahead child runs before the probe's budget is
// armed, so a slow refresh can never make the probe time out, and it is never
// killed. The probes' own kill waits while the CLI's refresh lock is held.
// Fakes only: no real child, no real store, no real lock.
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrimaryModelProbeAdapters, type PrimaryModelProbeAdapterDeps } from '../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts';
import { probePrimaryModelUsability } from '../../../src/runtimes/agent/providers/primary-model-usability.ts';
import { probeBinaryCommand } from '../../../src/runtimes/agent/providers/binary-preflight.ts';
import { refreshClaudeLoginAhead } from '../../../src/runtimes/agent/providers/claude-refresh-ahead.ts';
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

const quietLog = { info: () => undefined, warn: () => undefined };
const START = new Date('2026-10-19T09:00:00.000Z');
let savedConfigDir: string | undefined;

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '/tmp/refresh-ahead-wiring/.claude';
});
afterEach(() => {
  vi.useRealTimers();
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
});

function adapterDeps(probeSpawn: typeof import('node:child_process').spawn, over: Partial<PrimaryModelProbeAdapterDeps> = {}): PrimaryModelProbeAdapterDeps {
  return {
    getProviderBinary: () => 'claude',
    ensureClaudeFileStoreCredential: () => ({ outcome: 'skipped-file-store-current' }),
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

describe('diagnostic auth-status probe', () => {
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
