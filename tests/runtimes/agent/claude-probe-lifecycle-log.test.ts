// Spawn and exit lines for the other non-turn `claude` children: the
// account-identity probe and the diagnostic bundle's auth-status probe. Same
// shape as the primary-model probe lines (pid, start/end, duration, exit code,
// signal, whether a probe timeout killed it), under the shared
// claude_probe_spawn / claude_probe_exit events with a purpose. Content-free:
// no directory, no other env value, no child output. Fake children only.
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '../../../src/lib/clock.ts';
import { probeBinaryCommand } from '../../../src/runtimes/agent/providers/binary-preflight.ts';
import { observeClaudeAccountIdentity } from '../../../src/runtimes/agent/providers/claude-account-identity.ts';
import { makeAccountAuthStatusProbe } from '../../../src/runtimes/agent/providers/account-auth-status.ts';
import { runDiagnosticBundle } from '../../../src/runtimes/agent/diagnostic-bundle.ts';
import { RESPONSE_WORKFLOWS } from '../../../src/runtimes/agent/response-registry.ts';

const SVC = ['Claude', 'Code-credentials'].join(' ');
const CONFIG_DIR = '/tmp/probe-log-bot/.claude';
// Independent oracle: `printf %s /tmp/probe-log-bot/.claude | shasum -a 256 | cut -c1-8`.
const OWN_SERVICE = `${SVC}-a4a3c522`;
const OUTPUT_SENTINEL = 'auth-status-output-sentinel-5e0b';
const START = new Date('2026-10-19T10:00:00.000Z');

type FakeChild = EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };

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
  return { lines, log: { info: (obj: Record<string, unknown>, msg: string) => { lines.push({ obj, msg }); } } };
}

function expectNoLeak(lines: unknown): void {
  const text = JSON.stringify(lines);
  expect(text).not.toContain(CONFIG_DIR);
  expect(text).not.toContain(OUTPUT_SENTINEL);
}

beforeEach(() => { vi.useFakeTimers({ now: START }); });
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('account-identity probe lifecycle log', () => {
  it('logs spawn and exit of the auth status child', async () => {
    const child = fakeChild(3131);
    const { lines, log } = capture();
    const observed = observeClaudeAccountIdentity({
      getProviderBinary: () => 'claude',
      env: { CLAUDE_CONFIG_DIR: CONFIG_DIR, HOME: '/tmp/probe-log-home' },
      refreshClaudeLoginAhead: async () => undefined,
      claudeRefreshLockGrace: () => null,
      log,
      probeBinaryCommand: (binary, args, env, options) => probeBinaryCommand(binary, args, env, options, (() => child) as never),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.obj).toEqual({
      event: 'claude_probe_spawn',
      purpose: 'account-identity',
      credentialService: OWN_SERVICE,
      pid: 3131,
      startedAt: START.toISOString(),
    });
    await vi.advanceTimersByTimeAsync(800);
    child.stdout.emit('data', Buffer.from(`{"loggedIn":false,"note":"${OUTPUT_SENTINEL}"}`));
    child.emit('close', 1, null);
    await observed;
    expect(lines[1]!.obj).toEqual({
      event: 'claude_probe_exit',
      purpose: 'account-identity',
      credentialService: OWN_SERVICE,
      pid: 3131,
      startedAt: START.toISOString(),
      endedAt: new Date(START.getTime() + 800).toISOString(),
      durationMs: 800,
      exitCode: 1,
      signal: null,
      killedByProbeTimeout: false,
      termination: null,
      spawnFailed: false,
    });
    expectNoLeak(lines);
  });

  it('marks a probe killed by its own 15 s timer', async () => {
    const child = fakeChild(3232);
    const { lines, log } = capture();
    const observed = observeClaudeAccountIdentity({
      getProviderBinary: () => 'claude',
      env: { CLAUDE_CONFIG_DIR: CONFIG_DIR },
      refreshClaudeLoginAhead: async () => undefined,
      claudeRefreshLockGrace: () => null,
      log,
      probeBinaryCommand: (binary, args, env, options) => probeBinaryCommand(binary, args, env, options, (() => child) as never),
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit('close', null, 'SIGTERM');
    await observed;
    expect(lines[1]!.obj).toMatchObject({ event: 'claude_probe_exit', signal: 'SIGTERM', killedByProbeTimeout: true, termination: 'cli-timeout' });
  });
});

describe('diagnostic auth-status probe lifecycle log', () => {
  it.each([
    { provider: 'claude-cli', deadline: false },
    { provider: 'claude-cli', deadline: true },
    { provider: 'codex-cli', deadline: false },
    { provider: 'codex-cli', deadline: true },
  ])('diagnostic abort reaches a spawned $provider child (deadline=$deadline)', async ({ provider, deadline }) => {
    const child = fakeChild(3535);
    const { lines, log } = capture();
    const controller = new AbortController();
    const grace = Promise.withResolvers<void>();
    const terminationGrace = vi.fn(() => grace.promise);
    const run = makeAccountAuthStatusProbe({ provider }, {
      resolveKeyService: () => null,
      lookupCredential: () => null,
      getProviderBinary: () => provider,
      probeBinaryAuthStatus: (binary, args, env, options) => probeBinaryCommand(binary, args, env, options, (() => child) as never),
      isAuthRequiredMessage: () => false,
      env: { CLAUDE_CONFIG_DIR: CONFIG_DIR },
      terminationGrace,
      log,
    })(controller.signal);
    let settled = false;
    void run.then(() => { settled = true; });

    try {
      controller.abort(deadline ? new DOMException('diagnostic deadline', 'TimeoutError') : undefined);
      if (provider === 'claude-cli') {
        expect(terminationGrace).toHaveBeenCalledOnce();
        expect(child.kill).not.toHaveBeenCalled();
        grace.resolve();
        await vi.advanceTimersByTimeAsync(0);
      } else {
        expect(terminationGrace).not.toHaveBeenCalled();
      }
      expect(child.kill).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      child.emit('close', 0, null);
      await expect(run).resolves.toMatchObject({ ok: false, confidence: 'suspected' });
      if (provider === 'claude-cli') {
        expect(lines[1]!.obj).toMatchObject({
          event: 'claude_probe_exit',
          termination: deadline ? 'deadline' : 'caller-abort',
          killedByProbeTimeout: deadline,
        });
        expectNoLeak(lines);
      } else {
        expect(lines).toEqual([]);
      }
    } finally {
      grace.resolve();
      child.emit('close', 0, null);
      await run;
    }
  });

  it('diagnostic abort from the bundle deadline reaches the child before its own timeout', async () => {
    const child = fakeChild(3636);
    const { lines, log } = capture();
    const probe = makeAccountAuthStatusProbe({ provider: 'claude-cli' }, {
      resolveKeyService: () => null,
      lookupCredential: () => null,
      getProviderBinary: () => 'claude',
      probeBinaryAuthStatus: (binary, args, env, options) => probeBinaryCommand(binary, args, env, options, (() => child) as never),
      isAuthRequiredMessage: () => false,
      env: { CLAUDE_CONFIG_DIR: CONFIG_DIR },
      log,
    });
    const bundle = runDiagnosticBundle({
      workflow: RESPONSE_WORKFLOWS.provider_usage_limit,
      probes: { 'account-auth-status': probe },
      now: START.getTime(),
      perProbeTimeoutMs: 2_500,
    });
    try {
      await vi.advanceTimersByTimeAsync(2_500);
      expect(child.kill).toHaveBeenCalledOnce();
      expect((await bundle).findings).toContainEqual(expect.objectContaining({
        id: 'account-auth-status', ok: false, confidence: 'suspected',
        summary: 'probe account-auth-status timed out after 2500ms',
      }));
    } finally {
      child.emit('close', 0, null);
      await bundle;
    }
    expect(lines[1]!.obj).toMatchObject({
      event: 'claude_probe_exit', termination: 'deadline', killedByProbeTimeout: true,
    });
  });

  it('logs spawn and exit of the claude auth status child', async () => {
    const child = fakeChild(3333);
    const { lines, log } = capture();
    const run = makeAccountAuthStatusProbe({ provider: 'claude-cli' }, {
      resolveKeyService: () => null,
      lookupCredential: () => null,
      getProviderBinary: () => 'claude',
      probeBinaryAuthStatus: (binary, args, env, options) => probeBinaryCommand(binary, args, env, options, (() => child) as never),
      isAuthRequiredMessage: () => false,
      env: { CLAUDE_CONFIG_DIR: CONFIG_DIR },
      log,
    })(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(400);
    child.stdout.emit('data', Buffer.from(OUTPUT_SENTINEL));
    child.emit('close', 0, null);
    await run;
    expect(lines.map((l) => l.obj.event)).toEqual(['claude_probe_spawn', 'claude_probe_exit']);
    expect(lines[0]!.obj).toMatchObject({ purpose: 'diagnostic-auth-status', provider: 'claude-cli', credentialService: OWN_SERVICE, pid: 3333 });
    expect(lines[1]!.obj).toMatchObject({ purpose: 'diagnostic-auth-status', pid: 3333, durationMs: 400, exitCode: 0, killedByProbeTimeout: false });
    expectNoLeak(lines);
  });

  it.each([
    { movement: 'rolls back', endedAtMs: START.getTime() - 3_600_000 },
    { movement: 'jumps forward', endedAtMs: START.getTime() + 3_600_000 },
  ])('keeps duration monotonic when the wall clock $movement', async ({ endedAtMs }) => {
    const child = fakeChild(3434);
    const { lines, log } = capture();
    let wallNow = START.getTime();
    let monotonicNow = 40_000;
    vi.spyOn(systemClock, 'now').mockImplementation(() => wallNow);
    vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow);

    const run = makeAccountAuthStatusProbe({ provider: 'claude-cli' }, {
      resolveKeyService: () => null,
      lookupCredential: () => null,
      getProviderBinary: () => 'claude',
      probeBinaryAuthStatus: (binary, args, env, options) => probeBinaryCommand(binary, args, env, options, (() => child) as never),
      isAuthRequiredMessage: () => false,
      env: { CLAUDE_CONFIG_DIR: CONFIG_DIR },
      log,
    })(new AbortController().signal);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(800);
    wallNow = endedAtMs;
    monotonicNow += 800;
    child.stdout.emit('data', Buffer.from(OUTPUT_SENTINEL));
    child.emit('close', 0, null);
    await run;

    expect(lines[0]!.obj).toEqual({
      event: 'claude_probe_spawn',
      purpose: 'diagnostic-auth-status',
      provider: 'claude-cli',
      credentialService: OWN_SERVICE,
      pid: 3434,
      startedAt: START.toISOString(),
    });
    expect(lines[1]!.obj).toEqual({
      event: 'claude_probe_exit',
      purpose: 'diagnostic-auth-status',
      provider: 'claude-cli',
      credentialService: OWN_SERVICE,
      pid: 3434,
      startedAt: START.toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: 800,
      exitCode: 0,
      signal: null,
      killedByProbeTimeout: false,
      termination: null,
      spawnFailed: false,
    });
    expectNoLeak(lines);
  });
});
