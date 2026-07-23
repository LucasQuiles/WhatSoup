/**
 * Unit tests for src/runtimes/agent/providers/binary-preflight.ts
 *
 * All tests use an injectable spawnImpl so no real child process is ever
 * spawned. Each test builds a minimal EventEmitter-shaped fake whose event
 * sequence mirrors the real Node.js child_process.spawn API:
 *   - stdout 'data' events carry version text
 *   - child 'error' event carries an ErrnoException (e.g. ENOENT)
 *   - child 'close' event signals the process ended
 *
 * The timeout path is driven by returning a fake that never emits 'close',
 * then advancing fake timers past the 5 s probe window.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  probeFallbackBinary,
  probeBinaryAuthStatus,
  probeBinaryCommand,
} from '../../../../src/runtimes/agent/providers/binary-preflight.ts';

// ─── Fake child process builder ───────────────────────────────────────────────

interface FakeChildOptions {
  /** ENOENT or other error to emit on the 'error' event. */
  errorCode?: string;
  /** Lines of stdout to emit before 'close'. */
  stdoutLines?: string[];
  /** If true, never emit 'close' (simulates a hung process for timeout tests). */
  neverCloses?: boolean;
}

function makeFakeChild(opts: FakeChildOptions = {}): {
  child: EventEmitter & { stdout: EventEmitter; kill: ReturnType<typeof vi.fn> };
  triggerClose: () => void;
  triggerError: (code?: string) => void;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.kill = vi.fn();

  const triggerClose = (): void => {
    child.emit('close', 0, null);
  };

  const triggerError = (code = opts.errorCode ?? 'ENOENT'): void => {
    const err: NodeJS.ErrnoException = new Error(`spawn error: ${code}`);
    err.code = code;
    child.emit('error', err);
  };

  if (!opts.neverCloses) {
    // Emit stdout data + close asynchronously so callers can await the probe.
    setImmediate(() => {
      if (opts.errorCode) {
        triggerError(opts.errorCode);
        return;
      }
      for (const line of opts.stdoutLines ?? []) {
        child.stdout.emit('data', Buffer.from(line));
      }
      triggerClose();
    });
  }

  return { child, triggerClose, triggerError };
}

type SpawnImpl = typeof import('node:child_process').spawn;
const PROBE_ENV: NodeJS.ProcessEnv = { PATH: '/test/bin' };

function makeSpawnImpl(opts: FakeChildOptions): SpawnImpl {
  return ((_binary: string, _args: string[]) => {
    const { child } = makeFakeChild(opts);
    return child;
  }) as unknown as SpawnImpl;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.restoreAllMocks();
});

describe('probeFallbackBinary', () => {
  it('passes the caller-supplied environment explicitly to spawn', async () => {
    const env = { PATH: '/test/bin', HOME: '/test/home' };
    const spawnSpy = vi.fn((_binary: string, _args: string[]) =>
      makeFakeChild({ stdoutLines: ['opencode 0.3.14\n'] }).child);

    await probeFallbackBinary('opencode', env, spawnSpy as unknown as SpawnImpl);

    expect(spawnSpy).toHaveBeenCalledWith(
      'opencode',
      ['--version'],
      expect.objectContaining({ env }),
    );
  });

  // ── ENOENT → missing ────────────────────────────────────────────────────────

  it('returns missing when spawn error code is ENOENT', async () => {
    const spawnImpl = makeSpawnImpl({ errorCode: 'ENOENT' });
    const result = await probeFallbackBinary('no-such-binary', PROBE_ENV, spawnImpl);
    expect(result).toStrictEqual({ status: 'missing', version: null });
  });

  // ── successful execution → present ──────────────────────────────────────────

  it('returns present with version when binary exits cleanly with stdout', async () => {
    const spawnImpl = makeSpawnImpl({ stdoutLines: ['opencode 0.3.14\n'] });
    const result = await probeFallbackBinary('opencode', PROBE_ENV, spawnImpl);
    expect(result.status).toBe('present');
    expect(result.version).toBe('opencode 0.3.14');
  });

  it('returns present with null version when binary produces no stdout', async () => {
    const spawnImpl = makeSpawnImpl({ stdoutLines: [] });
    const result = await probeFallbackBinary('opencode', PROBE_ENV, spawnImpl);
    expect(result).toEqual({ status: 'present', version: null });
  });

  it('returns the first line only when stdout has multiple lines', async () => {
    const spawnImpl = makeSpawnImpl({ stdoutLines: ['v1.2.3\nignored line\n'] });
    const result = await probeFallbackBinary('opencode', PROBE_ENV, spawnImpl);
    expect(result.status).toBe('present');
    expect(result.version).toBe('v1.2.3');
  });

  // ── non-ENOENT error → unknown (fail-open) ──────────────────────────────────

  it('returns unknown for a non-ENOENT spawn error (fail-open)', async () => {
    const spawnImpl = makeSpawnImpl({ errorCode: 'EACCES' });
    const result = await probeFallbackBinary('opencode', PROBE_ENV, spawnImpl);
    expect(result).toStrictEqual({ status: 'unknown', version: null });
  });

  // ── timeout → unknown (fail-open) ───────────────────────────────────────────

  it('returns unknown and kills the child when the probe times out', async () => {
    vi.useFakeTimers();

    let killCalled = false;

    const fakeChild = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      kill: () => void;
    };
    fakeChild.stdout = new EventEmitter();
    fakeChild.kill = () => { killCalled = true; };

    const spawnImpl = ((_binary: string, _args: string[]) => fakeChild) as unknown as SpawnImpl;

    const probePromise = probeFallbackBinary('hung-binary', PROBE_ENV, spawnImpl);

    // Advance past the 5 000 ms timeout.
    await vi.advanceTimersByTimeAsync(5_001);

    const result = await probePromise;
    expect(result).toStrictEqual({ status: 'unknown', version: null });
    expect(killCalled).toBe(true);

    vi.useRealTimers();
  });

  // ── never throws ────────────────────────────────────────────────────────────

  it('never rejects even when spawnImpl synchronously throws', async () => {
    const throwingSpawnImpl = (() => {
      const err: NodeJS.ErrnoException = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }) as unknown as SpawnImpl;

    await expect(probeFallbackBinary('bad', PROBE_ENV, throwingSpawnImpl)).resolves.toMatchObject({
      status: 'missing',
      version: null,
    });
  });

  it('never rejects when spawnImpl throws a non-ENOENT error synchronously', async () => {
    const throwingSpawnImpl = (() => {
      const err: NodeJS.ErrnoException = new Error('EPERM');
      err.code = 'EPERM';
      throw err;
    }) as unknown as SpawnImpl;

    await expect(probeFallbackBinary('bad', PROBE_ENV, throwingSpawnImpl)).resolves.toMatchObject({
      status: 'unknown',
      version: null,
    });
  });
});

// ─── probeBinaryAuthStatus ────────────────────────────────────────────────────
//
// The primary recovery probe (`<binary> auth status --json`) used to run via
// spawnSync, freezing the whole event loop for up to 5 s per recheck — forever
// on a dead auth primary. These tests pin the async replacement: same 5 s
// timeout discipline as the other probes, plus SIGKILL escalation when the
// child ignores the first kill.

describe('probeBinaryAuthStatus', () => {
  interface AuthFakeChildOptions {
    errorCode?: string;
    stdoutChunks?: string[];
    stderrChunks?: string[];
    exitCode?: number;
    neverCloses?: boolean;
  }

  function makeAuthSpawnImpl(opts: AuthFakeChildOptions): {
    spawnImpl: SpawnImpl;
    killCalls: Array<string | number | undefined>;
  } {
    const killCalls: Array<string | number | undefined> = [];
    const spawnImpl = ((_binary: string, _args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: (signal?: string | number) => boolean;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = (signal?: string | number) => {
        killCalls.push(signal);
        return true;
      };
      if (!opts.neverCloses) {
        setImmediate(() => {
          if (opts.errorCode) {
            const err: NodeJS.ErrnoException = new Error(`spawn error: ${opts.errorCode}`);
            err.code = opts.errorCode;
            child.emit('error', err);
            return;
          }
          for (const chunk of opts.stdoutChunks ?? []) {
            child.stdout.emit('data', Buffer.from(chunk));
          }
          for (const chunk of opts.stderrChunks ?? []) {
            child.stderr.emit('data', Buffer.from(chunk));
          }
          child.emit('close', opts.exitCode ?? 0, null);
        });
      }
      return child;
    }) as unknown as SpawnImpl;
    return { spawnImpl, killCalls };
  }

  it('returns ok with combined stdout+stderr when the binary exits 0', async () => {
    const { spawnImpl } = makeAuthSpawnImpl({
      stdoutChunks: ['{"loggedIn":true}\n'],
      stderrChunks: ['some-warning\n'],
      exitCode: 0,
    });
    const result = await probeBinaryAuthStatus('claude', ['auth', 'status', '--json'], {}, spawnImpl);
    expect(result.status).toBe('ok');
    expect(result.output).toContain('{"loggedIn":true}');
    expect(result.output).toContain('some-warning');
  });

  it('returns failed on a non-zero exit, still carrying the output', async () => {
    const { spawnImpl } = makeAuthSpawnImpl({
      stdoutChunks: ['{"loggedIn":false}\n'],
      exitCode: 1,
    });
    const result = await probeBinaryAuthStatus('claude', ['auth', 'status', '--json'], {}, spawnImpl);
    expect(result.status).toBe('failed');
    expect(result.output).toContain('{"loggedIn":false}');
  });

  it('returns failed on a spawn error and never rejects', async () => {
    const { spawnImpl } = makeAuthSpawnImpl({ errorCode: 'ENOENT' });
    await expect(
      probeBinaryAuthStatus('no-such-binary', ['auth', 'status', '--json'], {}, spawnImpl),
    ).resolves.toMatchObject({ status: 'failed' });
  });

  it('never rejects when spawnImpl synchronously throws', async () => {
    const throwingSpawnImpl = (() => {
      throw new Error('EPERM');
    }) as unknown as SpawnImpl;
    await expect(
      probeBinaryAuthStatus('bad', ['auth', 'status', '--json'], {}, throwingSpawnImpl),
    ).resolves.toMatchObject({ status: 'failed' });
  });

  it('times out a hung child after 5 s, kills it, and escalates to SIGKILL when it ignores the first kill', async () => {
    vi.useFakeTimers();
    const { spawnImpl, killCalls } = makeAuthSpawnImpl({ neverCloses: true });

    const probePromise = probeBinaryAuthStatus('hung-binary', ['auth', 'status', '--json'], {}, spawnImpl);

    // Advance past the 5 000 ms timeout: first kill (default SIGTERM) + settle.
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await probePromise;
    expect(result.status).toBe('failed');
    expect(killCalls.length).toBe(1);
    expect(killCalls[0]).not.toBe('SIGKILL');

    // The child ignores the kill (no 'close'); the escalation timer must
    // SIGKILL it so a wedged probe can never accumulate zombie children.
    await vi.advanceTimersByTimeAsync(2_001);
    expect(killCalls).toContain('SIGKILL');

    vi.useRealTimers();
  });

  it('honors a caller-specific timeout for model-addressed probes', async () => {
    vi.useFakeTimers();
    const { spawnImpl, killCalls } = makeAuthSpawnImpl({ neverCloses: true });

    const probePromise = probeBinaryCommand(
      'claude',
      ['-p', 'Reply with OK only.', '--model', 'primary-model'],
      {},
      { timeoutMs: 15_000 },
      spawnImpl,
    );

    await vi.advanceTimersByTimeAsync(5_001);
    expect(killCalls).toEqual([]);

    await vi.advanceTimersByTimeAsync(10_000);
    const result = await probePromise;
    expect(result.status).toBe('failed');
    expect(killCalls.length).toBe(1);

    vi.useRealTimers();
  });

  it('does not report process closure at timeout before the child actually closes', async () => {
    vi.useFakeTimers();
    try {
      const onProcessClosed = vi.fn();
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      child.pid = 9911;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn(() => true);
      const spawnImpl = vi.fn(() => child) as unknown as SpawnImpl;
      const probe = probeBinaryCommand(
        'opencode',
        ['run', 'probe'],
        {},
        { timeoutMs: 15_000, onProcessClosed },
        spawnImpl,
      );

      await vi.advanceTimersByTimeAsync(15_001);
      await expect(probe).resolves.toMatchObject({ status: 'failed' });
      expect(onProcessClosed).not.toHaveBeenCalled();

      child.emit('close', null, 'SIGTERM');
      expect(onProcessClosed).toHaveBeenCalledOnce();
      child.emit('close', null, 'SIGTERM');
      expect(onProcessClosed).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not escalate to SIGKILL when the child dies on the first kill', async () => {
    vi.useFakeTimers();
    let childRef: EventEmitter | null = null;
    const killCalls: Array<string | number | undefined> = [];
    const spawnImpl = ((_binary: string, _args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: (signal?: string | number) => boolean;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = (signal?: string | number) => {
        killCalls.push(signal);
        // Child complies: signal delivery is asynchronous, so close on the
        // next microtask (drained by the awaited timer advances below).
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        return true;
      };
      childRef = child;
      return child;
    }) as unknown as SpawnImpl;

    const probePromise = probeBinaryAuthStatus('hung-binary', ['auth', 'status', '--json'], {}, spawnImpl);
    await vi.advanceTimersByTimeAsync(5_002);
    const result = await probePromise;
    expect(result.status).toBe('failed');
    expect(childRef).not.toBeNull();

    // Past the escalation window: the child already closed, no SIGKILL.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(killCalls).not.toContain('SIGKILL');

    vi.useRealTimers();
  });
});
