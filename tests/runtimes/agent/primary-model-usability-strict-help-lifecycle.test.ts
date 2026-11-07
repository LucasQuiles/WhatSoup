import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: childProcess.spawn,
}));

import { createPrimaryModelProbeAdapters } from '../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts';
import { probePrimaryModelUsability } from '../../../src/runtimes/agent/providers/primary-model-usability.ts';

const STRICT_HELP = '  --strict-mcp-config  Only use configured MCP servers\n';

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

function captureLog(): {
  lines: Array<{ obj: Record<string, unknown>; msg: string }>;
  log: { info: (obj: Record<string, unknown>, msg: string) => void };
} {
  const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  return {
    lines,
    log: { info: (obj, msg) => { lines.push({ obj, msg }); } },
  };
}

let fixtureNumber = 0;

function adaptersFor(log?: ReturnType<typeof captureLog>['log']) {
  const binary = `/fixture/claude-strict-help-lifecycle-${++fixtureNumber}`;
  return createPrimaryModelProbeAdapters(undefined, {
    getProviderBinary: () => binary,
    resolveProviderBinaryIdentity: () => ({ resolvedPath: binary, sha256: 'a'.repeat(64) }),
    ensureClaudeFileStoreCredential: () => ({ outcome: 'skipped-cli-reads-own-item' as const }),
    refreshClaudeLoginAhead: async () => undefined,
    ...(log ? { log } : {}),
  });
}

function queueChildren(...children: FakeChild[]): void {
  childProcess.spawn.mockImplementation(() => {
    const child = children.shift();
    if (!child) throw new Error('unexpected CLI child');
    return child;
  });
}

function expectNoContentLeak(lines: unknown): void {
  const text = JSON.stringify(lines);
  expect(text).not.toContain(STRICT_HELP.trim());
  expect(text).not.toContain('/fixture/');
  for (const key of ['HOME', 'PATH', 'USER'] as const) {
    const value = process.env[key];
    if (value) expect(text).not.toContain(JSON.stringify(value));
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  childProcess.spawn.mockReset();
});

describe('strict-MCP help lifecycle', () => {
  it('holds the model start until a timed-out strict-help child closes', async () => {
    vi.useFakeTimers();
    const help = fakeChild(4101);
    const model = fakeChild(4102);
    queueChildren(help, model);
    const attempt = adaptersFor().probeBinaryModel!({ provider: 'claude-cli', model: 'configured-primary' });

    try {
      expect(childProcess.spawn).toHaveBeenCalledOnce();
      expect(childProcess.spawn).toHaveBeenCalledWith(
        expect.stringContaining('claude-strict-help-lifecycle-'),
        ['--help'],
        expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
      );

      await vi.advanceTimersByTimeAsync(5_000);
      expect(help.kill).toHaveBeenNthCalledWith(1);
      expect(childProcess.spawn).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(help.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
      expect(childProcess.spawn).toHaveBeenCalledTimes(1);

      help.emit('close', null, 'SIGKILL');
      await vi.advanceTimersByTimeAsync(0);
      expect(childProcess.spawn).toHaveBeenCalledTimes(2);
      model.stdout.emit('data', Buffer.from('OK'));
      model.emit('close', 0, null);

      await expect(attempt).resolves.toEqual({ status: 'ok' });
    } finally {
      help.emit('close', null, 'SIGKILL');
      await vi.advanceTimersByTimeAsync(0);
      model.emit('close', 0, null);
      await attempt.catch(() => undefined);
    }
  });

  it('writes paired, content-free lifecycle records for strict-help', async () => {
    const help = fakeChild(4201);
    queueChildren(help);
    const { lines, log } = captureLog();
    const attempt = adaptersFor(log).probeBinaryModel!({ provider: 'claude-cli', model: 'configured-primary' });

    try {
      expect(lines).toHaveLength(1);
      expect(lines[0]!.obj).toMatchObject({ event: 'primary_model_probe_spawn', pid: 4201 });

      help.stdout.emit('data', Buffer.from('  --print  Print response and exit\n'));
      help.emit('close', 0, null);

      await expect(attempt).resolves.toEqual({
        status: 'unknown',
        reason: 'claude-cli-lacks-strict-mcp-config',
      });
      expect(lines).toHaveLength(2);
      expect(lines[1]!.obj).toMatchObject({
        event: 'primary_model_probe_exit',
        pid: 4201,
        exitCode: 0,
        signal: null,
        spawnFailed: false,
      });
      expectNoContentLeak(lines);
    } finally {
      help.emit('close', 0, null);
      await attempt.catch(() => undefined);
    }
  });

  it('attributes an outer deadline during strict-help to child-run without spawning a model', async () => {
    vi.useFakeTimers();
    const help = fakeChild(4301);
    queueChildren(help);
    const attempt = probePrimaryModelUsability(
      { provider: 'claude-cli', model: 'configured-primary' },
      adaptersFor(),
      { timeoutMs: 100 },
    );

    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(help.kill).toHaveBeenCalledOnce();
      expect(childProcess.spawn).toHaveBeenCalledTimes(1);

      help.emit('close', null, 'SIGTERM');
      await expect(attempt).resolves.toEqual({
        status: 'timeout',
        provider: 'claude-cli',
        model: 'configured-primary',
        reason: 'deadline-child-run',
      });
      expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    } finally {
      help.emit('close', null, 'SIGTERM');
      await attempt.catch(() => undefined);
    }
  });

  it('attributes a caller abort during strict-help to child-run without spawning a model', async () => {
    const controller = new AbortController();
    const help = fakeChild(4401);
    queueChildren(help);
    const attempt = probePrimaryModelUsability(
      { provider: 'claude-cli', model: 'configured-primary' },
      adaptersFor(),
      { signal: controller.signal },
    );

    try {
      await vi.waitFor(() => expect(childProcess.spawn).toHaveBeenCalledOnce());
      controller.abort();
      expect(help.kill).toHaveBeenCalledOnce();
      expect(childProcess.spawn).toHaveBeenCalledTimes(1);

      help.emit('close', null, 'SIGTERM');
      await expect(attempt).resolves.toEqual({
        status: 'timeout',
        provider: 'claude-cli',
        model: 'configured-primary',
        reason: 'caller-abort-child-run',
      });
      expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    } finally {
      help.emit('close', null, 'SIGTERM');
      await attempt.catch(() => undefined);
    }
  });
});
