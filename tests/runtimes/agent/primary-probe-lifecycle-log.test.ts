// The primary-model probe spawns `claude -p` every ~30 minutes. Each spawn and
// each exit must leave one structured info line, so a credential clear can be
// lined up against probe processes: pid, start and end time, duration, exit
// code, signal, and whether the probe's own timeout killed the child. The
// lines carry the keychain item name for the probe's config dir, never the
// config dir itself, any other environment value, or the child's output.
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrimaryModelProbeAdapters } from '../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts';
import { probePrimaryModelUsability } from '../../../src/runtimes/agent/providers/primary-model-usability.ts';
import { probeBinaryCommand as runBinaryCommandProbe } from '../../../src/runtimes/agent/providers/binary-preflight.ts';
import { buildPrimaryProbeAdapterDeps } from '../../../src/runtimes/agent/primary-readiness-probe.ts';

const SVC = ['Claude', 'Code-credentials'].join(' ');
const CONFIG_DIR = '/tmp/probe-log-bot/.claude';
// Independent oracle: `printf %s /tmp/probe-log-bot/.claude | shasum -a 256 | cut -c1-8`.
const OWN_SERVICE = `${SVC}-a4a3c522`;
const OUTPUT_SENTINEL = 'probe-output-sentinel-7f3a';
const START = new Date('2026-10-18T12:00:00.000Z');

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
  return {
    lines,
    log: { info: (obj: Record<string, unknown>, msg: string) => { lines.push({ obj, msg }); } },
  };
}

function adaptersFor(child: FakeChild, log: ReturnType<typeof capture>['log'], trigger = 'periodic') {
  const spawnImpl = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
  return createPrimaryModelProbeAdapters(undefined, {
    getProviderBinary: () => 'claude',
    ensureClaudeFileStoreCredential: () => ({ outcome: 'skipped-file-store-current' }),
    probeBinaryCommand: (binary, args, env, options) => runBinaryCommandProbe(binary, args, env, options, spawnImpl),
    probeTrigger: trigger as 'periodic',
    log,
  });
}

let savedConfigDir: string | undefined;
beforeEach(() => {
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = CONFIG_DIR;
  vi.useFakeTimers({ now: START });
});
afterEach(() => {
  vi.useRealTimers();
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
});

/** No environment value and no child output may appear in any line. */
function expectNoLeak(lines: unknown): void {
  const text = JSON.stringify(lines);
  expect(text).not.toContain(CONFIG_DIR);
  expect(text).not.toContain(OUTPUT_SENTINEL);
  for (const key of ['HOME', 'PATH', 'USER'] as const) {
    const value = process.env[key];
    if (value) expect(text).not.toContain(JSON.stringify(value));
  }
}

describe('primary model probe lifecycle log', () => {
  it('logs the spawn and the clean exit of a claude -p probe', async () => {
    const child = fakeChild(4242);
    const { lines, log } = capture();
    const probe = adaptersFor(child, log).probeBinaryModel!({ provider: 'claude-cli', model: 'claude-opus-4-8' });

    expect(lines).toEqual([{
      obj: {
        event: 'primary_model_probe_spawn',
        trigger: 'periodic',
        provider: 'claude-cli',
        pid: 4242,
        startedAt: '2026-10-18T12:00:00.000Z',
        credentialService: OWN_SERVICE,
      },
      msg: 'primary model probe spawned',
    }]);

    vi.advanceTimersByTime(1_234);
    child.stdout.emit('data', Buffer.from(`${OUTPUT_SENTINEL}\n`));
    child.emit('close', 0, null);
    await expect(probe).resolves.toEqual({ status: 'ok' });

    expect(lines[1]).toEqual({
      obj: {
        event: 'primary_model_probe_exit',
        trigger: 'periodic',
        provider: 'claude-cli',
        pid: 4242,
        startedAt: '2026-10-18T12:00:00.000Z',
        endedAt: '2026-10-18T12:00:01.234Z',
        durationMs: 1_234,
        exitCode: 0,
        signal: null,
        killedByProbeTimeout: false,
        termination: null,
        spawnFailed: false,
        credentialService: OWN_SERVICE,
      },
      msg: 'primary model probe exited',
    });
    expect(lines).toHaveLength(2);
    expectNoLeak(lines);
  });

  it('marks an exit caused by the CLI probe kill timer as killed by the probe timeout', async () => {
    const child = fakeChild(5151);
    const { lines, log } = capture();
    const probe = adaptersFor(child, log).probeBinaryModel!({ provider: 'claude-cli', model: null });

    vi.advanceTimersByTime(15_000);
    expect(child.kill).toHaveBeenCalledOnce();
    await probe;
    // The result settles at the kill; the exit line waits for the process to close.
    expect(lines).toHaveLength(1);
    vi.advanceTimersByTime(300);
    child.emit('close', null, 'SIGTERM');

    expect(lines[1]!.obj).toMatchObject({
      event: 'primary_model_probe_exit',
      pid: 5151,
      durationMs: 15_300,
      exitCode: null,
      signal: 'SIGTERM',
      killedByProbeTimeout: true,
      termination: 'cli-timeout',
    });
    expectNoLeak(lines);
  });

  it('marks an exit caused by the usability deadline as killed by the probe timeout', async () => {
    const child = fakeChild(6262);
    const { lines, log } = capture();
    const result = probePrimaryModelUsability(
      { provider: 'claude-cli', model: 'claude-opus-4-8' },
      adaptersFor(child, log, 'manual'),
      { timeoutMs: 5_000 },
    );

    vi.advanceTimersByTime(5_000);
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit('close', null, 'SIGTERM');
    await expect(result).resolves.toMatchObject({ status: 'timeout' });

    expect(lines.map((l) => l.obj.event)).toEqual(['primary_model_probe_spawn', 'primary_model_probe_exit']);
    expect(lines[1]!.obj).toMatchObject({
      trigger: 'manual',
      pid: 6262,
      durationMs: 5_000,
      signal: 'SIGTERM',
      killedByProbeTimeout: true,
      termination: 'deadline',
    });
  });

  it('does not report a caller cancellation as a probe timeout', async () => {
    const child = fakeChild(7373);
    const { lines, log } = capture();
    const controller = new AbortController();
    const result = probePrimaryModelUsability(
      { provider: 'claude-cli', model: 'claude-opus-4-8' },
      adaptersFor(child, log, 'recovery'),
      { signal: controller.signal },
    );

    vi.advanceTimersByTime(2_000);
    controller.abort();
    child.emit('close', null, 'SIGTERM');
    await result;

    expect(lines[1]!.obj).toMatchObject({
      trigger: 'recovery',
      signal: 'SIGTERM',
      killedByProbeTimeout: false,
      termination: 'caller-abort',
    });
  });

  it('logs a spawn line (pid null) before the exit line when spawn() throws synchronously', async () => {
    const { lines, log } = capture();
    const spawnImpl = vi.fn(() => { throw new Error('spawn EMFILE'); }) as unknown as typeof import('node:child_process').spawn;
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      getProviderBinary: () => 'claude',
      ensureClaudeFileStoreCredential: () => ({ outcome: 'skipped-file-store-current' }),
      probeBinaryCommand: (binary, args, env, options) => runBinaryCommandProbe(binary, args, env, options, spawnImpl),
      probeTrigger: 'periodic',
      log,
    });
    await adapters.probeBinaryModel!({ provider: 'claude-cli', model: null });

    expect(lines.map((l) => l.obj.event)).toEqual(['primary_model_probe_spawn', 'primary_model_probe_exit']);
    expect(lines[0]!.obj.pid).toBeNull();
    expect(lines[1]!.obj).toMatchObject({ pid: null, spawnFailed: true, exitCode: null, signal: null, killedByProbeTimeout: false });
  });

  it('names the default keychain item when the probe runs without CLAUDE_CONFIG_DIR', async () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    const child = fakeChild(8484);
    const { lines, log } = capture();
    const probe = adaptersFor(child, log).probeBinaryModel!({ provider: 'claude-cli', model: null });
    child.emit('close', 1, null);
    await probe;

    expect(lines.map((l) => l.obj.credentialService)).toEqual(['default', 'default']);
    expect(lines[1]!.obj).toMatchObject({ exitCode: 1, signal: null, killedByProbeTimeout: false });
  });
});

describe('primary model probe lifecycle log with a real child process', () => {
  it('carries the same non-null pid in the spawn and exit lines of a successful spawn', async () => {
    vi.useRealTimers();
    const { lines, log } = capture();
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      getProviderBinary: () => process.execPath,
      ensureClaudeFileStoreCredential: () => ({ outcome: 'skipped-file-store-current' }),
      // A real spawn of node itself, which exits 0 at once; the probe's own argv is replaced.
      probeBinaryCommand: (binary, _args, env, options) => runBinaryCommandProbe(binary, ['-e', ''], env, options),
      probeTrigger: 'periodic',
      log,
    });
    await expect(adapters.probeBinaryModel!({ provider: 'claude-cli', model: null })).resolves.toEqual({ status: 'ok' });

    expect(lines.map((l) => l.obj.event)).toEqual(['primary_model_probe_spawn', 'primary_model_probe_exit']);
    const pid = lines[0]!.obj.pid;
    expect(typeof pid).toBe('number');
    expect(pid as number).toBeGreaterThan(0);
    expect(lines[1]!.obj).toMatchObject({ pid, exitCode: 0, signal: null, spawnFailed: false });
  });
});

describe('buildPrimaryProbeAdapterDeps', () => {
  it('carries the probe trigger into the adapter deps', () => {
    expect(buildPrimaryProbeAdapterDeps('claude-cli', null, '/tmp/x', undefined, undefined, 'periodic').probeTrigger)
      .toBe('periodic');
  });
});
