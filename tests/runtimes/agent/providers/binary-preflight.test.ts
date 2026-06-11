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
import { probeFallbackBinary } from '../../../../src/runtimes/agent/providers/binary-preflight.ts';

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
  // ── ENOENT → missing ────────────────────────────────────────────────────────

  it('returns missing when spawn error code is ENOENT', async () => {
    const spawnImpl = makeSpawnImpl({ errorCode: 'ENOENT' });
    const result = await probeFallbackBinary('no-such-binary', spawnImpl);
    expect(result).toStrictEqual({ status: 'missing', version: null });
  });

  // ── successful execution → present ──────────────────────────────────────────

  it('returns present with version when binary exits cleanly with stdout', async () => {
    const spawnImpl = makeSpawnImpl({ stdoutLines: ['opencode 0.3.14\n'] });
    const result = await probeFallbackBinary('opencode', spawnImpl);
    expect(result.status).toBe('present');
    expect(result.version).toBe('opencode 0.3.14');
  });

  it('returns present with null version when binary produces no stdout', async () => {
    const spawnImpl = makeSpawnImpl({ stdoutLines: [] });
    const result = await probeFallbackBinary('opencode', spawnImpl);
    expect(result.status).toBe('present');
    expect(result.version).toBeNull();
  });

  it('returns the first line only when stdout has multiple lines', async () => {
    const spawnImpl = makeSpawnImpl({ stdoutLines: ['v1.2.3\nignored line\n'] });
    const result = await probeFallbackBinary('opencode', spawnImpl);
    expect(result.status).toBe('present');
    expect(result.version).toBe('v1.2.3');
  });

  // ── non-ENOENT error → unknown (fail-open) ──────────────────────────────────

  it('returns unknown for a non-ENOENT spawn error (fail-open)', async () => {
    const spawnImpl = makeSpawnImpl({ errorCode: 'EACCES' });
    const result = await probeFallbackBinary('opencode', spawnImpl);
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

    const probePromise = probeFallbackBinary('hung-binary', spawnImpl);

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

    await expect(probeFallbackBinary('bad', throwingSpawnImpl)).resolves.toMatchObject({
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

    await expect(probeFallbackBinary('bad', throwingSpawnImpl)).resolves.toMatchObject({
      status: 'unknown',
      version: null,
    });
  });
});
