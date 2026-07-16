/**
 * Unit tests for probeModelCatalog in
 * src/runtimes/agent/providers/binary-preflight.ts
 *
 * The probe spawns `<binary> models` and matches the configured model id
 * against the catalog ids printed on stdout:
 *
 *  - exact match                         → { status: 'found',     suggestion: null }
 *  - case-insensitive match only         → { status: 'not_found', suggestion: <catalog casing> }
 *  - no match at all                     → { status: 'not_found', suggestion: null }
 *  - spawn error / timeout / empty out   → { status: 'unknown',   suggestion: null } (fail-open)
 *
 * All tests use an injectable spawnImpl so no real child process is ever
 * spawned. The fake child mirrors the harness used by the probeFallbackBinary
 * unit tests (tests/runtimes/agent/providers/binary-preflight.test.ts):
 * EventEmitter-shaped, stdout 'data' events, 'error' / 'close' events, with
 * fake timers driving the timeout path.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { probeModelCatalog } from '../../../src/runtimes/agent/providers/binary-preflight.ts';

// ─── Fake child process builder ───────────────────────────────────────────────

interface FakeChildOptions {
  /** ENOENT or other error to emit on the 'error' event. */
  errorCode?: string;
  /** Chunks of stdout to emit before 'close'. */
  stdoutChunks?: string[];
  /** If true, never emit 'close' (simulates a hung process for timeout tests). */
  neverCloses?: boolean;
}

function makeFakeChild(opts: FakeChildOptions = {}): EventEmitter & {
  stdout: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.kill = vi.fn();

  if (!opts.neverCloses) {
    // Emit stdout data + close asynchronously so callers can await the probe.
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
      child.emit('close', 0, null);
    });
  }

  return child;
}

type SpawnImpl = typeof import('node:child_process').spawn;
const PROBE_ENV: NodeJS.ProcessEnv = { PATH: '/test/bin' };

function makeSpawnImpl(opts: FakeChildOptions): SpawnImpl {
  return ((_binary: string, _args: string[]) => makeFakeChild(opts)) as unknown as SpawnImpl;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.restoreAllMocks();
});

describe('probeModelCatalog', () => {
  it('passes the caller-supplied environment explicitly to spawn', async () => {
    const env = { PATH: '/test/bin', HOME: '/test/home' };
    const spawnSpy = vi.fn((_binary: string, _args: string[]) =>
      makeFakeChild({ stdoutChunks: ['minimax/MiniMax-M2\n'] }));

    await probeModelCatalog(
      'opencode',
      'minimax/MiniMax-M2',
      env,
      spawnSpy as unknown as SpawnImpl,
    );

    expect(spawnSpy).toHaveBeenCalledWith(
      'opencode',
      ['models'],
      expect.objectContaining({ env }),
    );
  });

  // ── exact match → found ─────────────────────────────────────────────────────

  it('returns found when the model id matches a catalog line exactly', async () => {
    const spawnImpl = makeSpawnImpl({
      stdoutChunks: ['minimax/MiniMax-M2\nminimax/MiniMax-Text-01\ndeepseek/deepseek-chat\n'],
    });
    const result = await probeModelCatalog('opencode', 'minimax/MiniMax-M2', PROBE_ENV, spawnImpl);
    expect(result).toStrictEqual({ status: 'found', suggestion: null });
  });

  it('spawns `<binary> models` with the binary under probe', async () => {
    const spawnSpy = vi.fn((_binary: string, _args: string[]) =>
      makeFakeChild({ stdoutChunks: ['minimax/MiniMax-M2\n'] }));
    await probeModelCatalog(
      'opencode',
      'minimax/MiniMax-M2',
      PROBE_ENV,
      spawnSpy as unknown as SpawnImpl,
    );
    expect(spawnSpy).toHaveBeenCalledWith('opencode', ['models'], expect.anything());
  });

  // ── case-insensitive match → not_found with suggestion ──────────────────────

  it('returns not_found with the catalog casing when only a case-insensitive match exists', async () => {
    const spawnImpl = makeSpawnImpl({
      stdoutChunks: ['minimax/MiniMax-M2\ndeepseek/deepseek-chat\n'],
    });
    const result = await probeModelCatalog('opencode', 'minimax/minimax-m2', PROBE_ENV, spawnImpl);
    expect(result).toStrictEqual({ status: 'not_found', suggestion: 'minimax/MiniMax-M2' });
  });

  // ── no match → not_found with null suggestion ───────────────────────────────

  it('returns not_found with null suggestion when no catalog line matches', async () => {
    const spawnImpl = makeSpawnImpl({
      stdoutChunks: ['deepseek/deepseek-chat\nopenai/gpt-5.4\n'],
    });
    const result = await probeModelCatalog('opencode', 'minimax/minimax-m2', PROBE_ENV, spawnImpl);
    expect(result).toStrictEqual({ status: 'not_found', suggestion: null });
  });

  // ── output parsing tolerates blank lines and whitespace ─────────────────────

  it('tolerates blank lines, surrounding whitespace, and split chunks', async () => {
    const spawnImpl = makeSpawnImpl({
      stdoutChunks: ['\n  deepseek/deepseek-chat  \n\n', '  minimax/MiniM', 'ax-M2\t\n\n'],
    });
    const result = await probeModelCatalog('opencode', 'minimax/MiniMax-M2', PROBE_ENV, spawnImpl);
    expect(result).toStrictEqual({ status: 'found', suggestion: null });
  });

  // ── empty output → unknown (fail-open) ──────────────────────────────────────

  it('returns unknown when the catalog command produces no output', async () => {
    const spawnImpl = makeSpawnImpl({ stdoutChunks: [] });
    const result = await probeModelCatalog('opencode', 'minimax/MiniMax-M2', PROBE_ENV, spawnImpl);
    expect(result).toStrictEqual({ status: 'unknown', suggestion: null });
  });

  it('returns unknown when stdout is only whitespace', async () => {
    const spawnImpl = makeSpawnImpl({ stdoutChunks: ['\n   \n\n'] });
    const result = await probeModelCatalog('opencode', 'minimax/MiniMax-M2', PROBE_ENV, spawnImpl);
    expect(result).toStrictEqual({ status: 'unknown', suggestion: null });
  });

  // ── spawn error → unknown (fail-open) ───────────────────────────────────────

  it('returns unknown on an ENOENT spawn error', async () => {
    const spawnImpl = makeSpawnImpl({ errorCode: 'ENOENT' });
    const result = await probeModelCatalog('opencode', 'minimax/MiniMax-M2', PROBE_ENV, spawnImpl);
    expect(result).toStrictEqual({ status: 'unknown', suggestion: null });
  });

  it('returns unknown on a non-ENOENT spawn error', async () => {
    const spawnImpl = makeSpawnImpl({ errorCode: 'EACCES' });
    const result = await probeModelCatalog('opencode', 'minimax/MiniMax-M2', PROBE_ENV, spawnImpl);
    expect(result).toStrictEqual({ status: 'unknown', suggestion: null });
  });

  // ── timeout → unknown (fail-open), child killed ─────────────────────────────

  it('returns unknown and kills the child when the probe times out', async () => {
    vi.useFakeTimers();

    const fakeChild = makeFakeChild({ neverCloses: true });
    const spawnImpl = ((_binary: string, _args: string[]) => fakeChild) as unknown as SpawnImpl;

    const probePromise = probeModelCatalog('opencode', 'minimax/MiniMax-M2', PROBE_ENV, spawnImpl);

    // Advance past the 5 000 ms probe window.
    await vi.advanceTimersByTimeAsync(5_001);

    const result = await probePromise;
    expect(result).toStrictEqual({ status: 'unknown', suggestion: null });
    expect(fakeChild.kill).toHaveBeenCalled();

    vi.useRealTimers();
  });

  // ── never throws ────────────────────────────────────────────────────────────

  it('never rejects even when spawnImpl synchronously throws', async () => {
    const throwingSpawnImpl = (() => {
      const err: NodeJS.ErrnoException = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }) as unknown as SpawnImpl;

    await expect(
      probeModelCatalog('opencode', 'minimax/MiniMax-M2', PROBE_ENV, throwingSpawnImpl),
    ).resolves.toStrictEqual({ status: 'unknown', suggestion: null });
  });
});
