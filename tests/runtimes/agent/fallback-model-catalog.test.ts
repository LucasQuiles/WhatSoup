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
 *  - probe failure                       → { status: 'unknown',   suggestion: null } (fail-open)
 *
 * Full-list discovery additionally distinguishes spawn errors, timeouts,
 * empty output, command errors, malformed output, and output-limit failures.
 *
 * All tests use an injectable spawnImpl so no real child process is ever
 * spawned. The fake child mirrors the harness used by the probeFallbackBinary
 * unit tests (tests/runtimes/agent/providers/binary-preflight.test.ts):
 * EventEmitter-shaped, stdout 'data' events, 'error' / 'close' events, with
 * fake timers driving the timeout path.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  probeModelCatalog,
  listModelCatalog,
  listCodexModelCatalog,
} from '../../../src/runtimes/agent/providers/binary-preflight.ts';

// ─── Fake child process builder ───────────────────────────────────────────────

interface FakeChildOptions {
  /** ENOENT or other error to emit on the 'error' event. */
  errorCode?: string;
  /** Chunks of stdout to emit before 'close'. */
  stdoutChunks?: string[];
  /** Chunks of stderr to emit before 'close'. */
  stderrChunks?: string[];
  /** Exit code emitted with 'close' (default 0). */
  exitCode?: number;
  /** If true, never emit 'close' (simulates a hung process for timeout tests). */
  neverCloses?: boolean;
}

function makeFakeChild(opts: FakeChildOptions = {}): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
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
      for (const chunk of opts.stderrChunks ?? []) {
        child.stderr.emit('data', Buffer.from(chunk));
      }
      child.emit('close', opts.exitCode ?? 0, null);
    });
  }

  return child;
}

type SpawnImpl = typeof import('node:child_process').spawn;
const PROBE_ENV: NodeJS.ProcessEnv = { PATH: '/test/bin' };

function makeSpawnImpl(opts: FakeChildOptions): SpawnImpl {
  return ((_binary: string, _args: string[]) => makeFakeChild(opts)) as unknown as SpawnImpl;
}

function makeSpawnSequence(sequence: FakeChildOptions[]): {
  spawnImpl: SpawnImpl;
  spawnSpy: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const spawnSpy = vi.fn((_binary: string, _args: string[]) => {
    const opts = sequence[index];
    index += 1;
    if (!opts) throw new Error(`unexpected catalogue spawn ${index}`);
    return makeFakeChild(opts);
  });
  return { spawnImpl: spawnSpy as unknown as SpawnImpl, spawnSpy };
}

function verboseEntry(
  id: string,
  metadata: Record<string, unknown>,
): string {
  return `${id}\n${JSON.stringify(metadata, null, 2)}\n`;
}

function verboseModel(
  id: string,
  overrides: Record<string, unknown> = {},
): string {
  const slash = id.indexOf('/');
  return verboseEntry(id, {
    id: id.slice(slash + 1),
    providerID: id.slice(0, slash),
    status: 'active',
    release_date: '2026-08-20',
    cost: { input: 0, output: 0 },
    capabilities: {
      toolcall: true,
      output: { text: true },
    },
    ...overrides,
  });
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

// ─── listModelCatalog: dynamic per-harness catalogue LISTER ───────────────────
// Same `<binary> models` spawn + 5 s kill-timer discipline as probeModelCatalog,
// but returns the FULL id list (not a found/not_found verdict) for the /config
// model catalogue render. Honest-degrade contract (CONFIG-SURFACE-MAP.md #4):
// anything that isn't a clean close with ≥1 id → { status: 'unavailable', reason }
// where reason ∈ spawn-error | timeout | empty (Q 2b#3: a timeout must not read
// as an empty catalogue).
// so the render says "catalogue unavailable (as of …)", never a fake/stale list.

describe('listModelCatalog', () => {
  it('accepts the exact ANSI refresh banner emitted before verbose records', async () => {
    const output = `\u001b[92m\u001b[1mModels cache refreshed\u001b[0m\n${verboseModel('glm/glm-5.2')}`;
    const { spawnImpl, spawnSpy } = makeSpawnSequence([{ stdoutChunks: [output] }]);

    const result = await listModelCatalog('opencode', spawnImpl);

    expect(result).toMatchObject({
      status: 'ok',
      ids: ['glm/glm-5.2'],
      captureMode: 'refreshed',
    });
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it('refreshes a pure verbose catalogue and returns normalized metadata in catalogue order', async () => {
    const output = [
      verboseModel('minimax/MiniMax-M2'),
      verboseModel('deepseek/deepseek-chat', { release_date: '2026-07-01' }),
    ].join('');
    const { spawnImpl, spawnSpy } = makeSpawnSequence([{ stdoutChunks: [output] }]);

    const result = await listModelCatalog('opencode', spawnImpl);

    expect(result).toStrictEqual({
      status: 'ok',
      ids: ['minimax/MiniMax-M2', 'deepseek/deepseek-chat'],
      metadata: {
        'minimax/MiniMax-M2': {
          status: 'active',
          releaseDate: '2026-08-20',
          textOutput: true,
          toolCall: true,
          zeroCost: true,
        },
        'deepseek/deepseek-chat': {
          status: 'active',
          releaseDate: '2026-07-01',
          textOutput: true,
          toolCall: true,
          zeroCost: true,
        },
      },
      captureMode: 'refreshed',
    });
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy).toHaveBeenCalledWith(
      'opencode',
      ['models', '--pure', '--refresh', '--verbose'],
      expect.anything(),
    );
  });

  it('falls back to cached pure verbose metadata when the upstream refresh fails', async () => {
    const { spawnImpl, spawnSpy } = makeSpawnSequence([
      { stderrChunks: ['refresh failed'], exitCode: 1 },
      { stdoutChunks: [verboseModel('glm/glm-5.2')] },
    ]);

    const result = await listModelCatalog('opencode', spawnImpl);

    expect(result).toStrictEqual({
      status: 'ok',
      ids: ['glm/glm-5.2'],
      metadata: {
        'glm/glm-5.2': {
          status: 'active',
          releaseDate: '2026-08-20',
          textOutput: true,
          toolCall: true,
          zeroCost: true,
        },
      },
      captureMode: 'cached',
      refreshFailure: 'command-error',
    });
    expect(spawnSpy.mock.calls.map((call) => call[1])).toEqual([
      ['models', '--pure', '--refresh', '--verbose'],
      ['models', '--pure', '--verbose'],
    ]);
  });

  it('falls back to the legacy id-only command when verbose metadata is unsupported', async () => {
    const { spawnImpl, spawnSpy } = makeSpawnSequence([
      { stderrChunks: ['unknown option --verbose'], exitCode: 1 },
      { stderrChunks: ['unknown option --verbose'], exitCode: 1 },
      { stdoutChunks: ['\n  deepseek/deepseek-chat  \n\n', '  minimax/MiniM', 'ax-M2\t\n\n'] },
    ]);

    const result = await listModelCatalog('opencode', spawnImpl);

    expect(result).toStrictEqual({
      status: 'ok',
      ids: ['deepseek/deepseek-chat', 'minimax/MiniMax-M2'],
      metadata: {},
      captureMode: 'legacy',
      refreshFailure: 'command-error',
    });
    expect(spawnSpy.mock.calls.map((call) => call[1])).toEqual([
      ['models', '--pure', '--refresh', '--verbose'],
      ['models', '--pure', '--verbose'],
      ['models'],
    ]);
  });

  it('does not trust mismatched verbose metadata and degrades to legacy ids', async () => {
    const mismatched = verboseModel('glm/glm-5.2', { id: 'different-model' });
    const { spawnImpl } = makeSpawnSequence([
      { stdoutChunks: [mismatched] },
      { stdoutChunks: [mismatched] },
      { stdoutChunks: ['glm/glm-5.2\n'] },
    ]);

    await expect(listModelCatalog('opencode', spawnImpl)).resolves.toStrictEqual({
      status: 'ok',
      ids: ['glm/glm-5.2'],
      metadata: {},
      captureMode: 'legacy',
      refreshFailure: 'unparseable',
    });
  });

  it('keeps an id but drops malformed optional metadata fields', async () => {
    const output = verboseModel('glm/glm-5.2', {
      release_date: '2026-02-31',
      cost: { input: '0', output: '0' },
      capabilities: { toolcall: 'true', output: { text: 'true' } },
    });

    const result = await listModelCatalog('opencode', makeSpawnImpl({ stdoutChunks: [output] }));

    expect(result).toStrictEqual({
      status: 'ok',
      ids: ['glm/glm-5.2'],
      metadata: { 'glm/glm-5.2': { status: 'active' } },
      captureMode: 'refreshed',
    });
  });

  it('retains valid month-precision release dates from the upstream schema', async () => {
    const output = verboseModel('glm/month-precision', { release_date: '2026-08' });

    const result = await listModelCatalog('opencode', makeSpawnImpl({ stdoutChunks: [output] }));

    expect(result).toMatchObject({
      status: 'ok',
      metadata: { 'glm/month-precision': { releaseDate: '2026-08' } },
    });
  });

  it('does not classify a model as zero-cost when any cache price is non-zero', async () => {
    const output = verboseModel('opencode/cache-priced', {
      cost: { input: 0, output: 0, cache: { read: 0.25, write: 0 } },
    });

    const result = await listModelCatalog('opencode', makeSpawnImpl({ stdoutChunks: [output] }));

    expect(result).toMatchObject({
      status: 'ok',
      metadata: { 'opencode/cache-priced': { zeroCost: false } },
    });
  });

  it('bounds refreshed output and labels a cached fallback after the limit is exceeded', async () => {
    const oversized = 'x'.repeat(8 * 1024 * 1024 + 1);
    const firstChild = makeFakeChild({ stdoutChunks: [oversized] });
    const secondChild = makeFakeChild({ stdoutChunks: [verboseModel('glm/glm-5.2')] });
    let spawnIndex = 0;
    const spawnImpl = ((_binary: string, _args: string[]) =>
      [firstChild, secondChild][spawnIndex++]!) as unknown as SpawnImpl;

    const result = await listModelCatalog('opencode', spawnImpl);

    expect(result).toMatchObject({
      status: 'ok',
      ids: ['glm/glm-5.2'],
      captureMode: 'cached',
      refreshFailure: 'output-limit',
    });
    expect(firstChild.kill).toHaveBeenCalled();
  });

  it('returns unavailable when the catalog command produces no output', async () => {
    const { spawnImpl } = makeSpawnSequence([
      { stdoutChunks: [] },
      { stdoutChunks: [] },
      { stdoutChunks: [] },
    ]);
    const result = await listModelCatalog('opencode', spawnImpl);
    expect(result).toStrictEqual({ status: 'unavailable', reason: 'empty' });
  });

  it('returns unavailable when stdout is only whitespace', async () => {
    const { spawnImpl } = makeSpawnSequence([
      { stdoutChunks: ['\n   \n\n'] },
      { stdoutChunks: ['\n   \n\n'] },
      { stdoutChunks: ['\n   \n\n'] },
    ]);
    const result = await listModelCatalog('opencode', spawnImpl);
    expect(result).toStrictEqual({ status: 'unavailable', reason: 'empty' });
  });

  it('rejects non-catalogue legacy output instead of turning it into model ids', async () => {
    const { spawnImpl } = makeSpawnSequence([
      { stderrChunks: ['unknown option'], exitCode: 1 },
      { stderrChunks: ['unknown option'], exitCode: 1 },
      { stdoutChunks: ['{"error":"authentication"}\n'] },
    ]);

    await expect(listModelCatalog('opencode', spawnImpl)).resolves.toStrictEqual({
      status: 'unavailable',
      reason: 'unparseable',
    });
  });

  it('returns unavailable on an ENOENT spawn error', async () => {
    const result = await listModelCatalog('opencode', makeSpawnImpl({ errorCode: 'ENOENT' }));
    expect(result).toStrictEqual({ status: 'unavailable', reason: 'spawn-error' });
  });

  it('returns unavailable on a non-ENOENT spawn error', async () => {
    const result = await listModelCatalog('opencode', makeSpawnImpl({ errorCode: 'EACCES' }));
    expect(result).toStrictEqual({ status: 'unavailable', reason: 'spawn-error' });
  });

  it('returns unavailable and kills the child when the listing times out', async () => {
    vi.useFakeTimers();
    const children = [
      makeFakeChild({ neverCloses: true }),
      makeFakeChild({ neverCloses: true }),
    ];
    let index = 0;
    const spawnSpy = vi.fn((_binary: string, _args: string[]) => children[index++]!);
    const spawnImpl = spawnSpy as unknown as SpawnImpl;

    const listPromise = listModelCatalog('opencode', spawnImpl);
    await vi.advanceTimersByTimeAsync(5_001);
    await vi.advanceTimersByTimeAsync(5_001);

    expect(await listPromise).toStrictEqual({ status: 'unavailable', reason: 'timeout' });
    expect(children.every((child) => child.kill.mock.calls.length > 0)).toBe(true);
    expect(spawnSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('never rejects even when spawnImpl synchronously throws', async () => {
    const throwingSpawnImpl = (() => {
      const err: NodeJS.ErrnoException = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }) as unknown as SpawnImpl;

    await expect(listModelCatalog('opencode', throwingSpawnImpl)).resolves.toStrictEqual({
      status: 'unavailable',
      reason: 'spawn-error',
    });
  });
});

describe('listCodexModelCatalog', () => {
  it('runs the native diagnostic command and returns only picker-visible slugs in catalogue order', async () => {
    const output = JSON.stringify({
      models: [
        { slug: 'gpt-reserve', visibility: 'hide' },
        { slug: 'gpt-5.6-sol', visibility: 'list' },
        { slug: 'gpt-internal', visibility: 'none' },
        { slug: 'gpt-5.5', visibility: 'list' },
      ],
    });
    const spawnSpy = vi.fn((_binary: string, _args: string[]) =>
      makeFakeChild({ stdoutChunks: [output] }));

    await expect(
      listCodexModelCatalog('/opt/codex', spawnSpy as unknown as SpawnImpl),
    ).resolves.toStrictEqual({
      status: 'ok',
      ids: ['gpt-5.6-sol', 'gpt-5.5'],
    });
    expect(spawnSpy).toHaveBeenCalledWith(
      '/opt/codex',
      ['debug', 'models', '--disable', 'multi_agent'],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: undefined,
        windowsHide: true,
      },
    );
  });

  it.each([
    ['non-object root', '[]'],
    ['missing models array', JSON.stringify({ model: [] })],
    ['unknown visibility', JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', visibility: 'preview' }] })],
    ['unsafe slug', JSON.stringify({ models: [{ slug: 'gpt 5.6', visibility: 'list' }] })],
    ['duplicate slug', JSON.stringify({ models: [
      { slug: 'gpt-5.6-sol', visibility: 'list' },
      { slug: 'gpt-5.6-sol', visibility: 'hide' },
    ] })],
  ])('rejects %s instead of trusting a partial catalogue', async (_name, output) => {
    await expect(
      listCodexModelCatalog('codex', makeSpawnImpl({ stdoutChunks: [output] })),
    ).resolves.toStrictEqual({ status: 'unavailable', reason: 'unparseable' });
  });

  it('rejects a shape-valid catalogue above the defensive entry ceiling', async () => {
    const output = JSON.stringify({
      models: Array.from({ length: 4_097 }, (_, index) => ({
        slug: `gpt-catalogue-${index}`,
        visibility: 'list',
      })),
    });

    await expect(
      listCodexModelCatalog('codex', makeSpawnImpl({ stdoutChunks: [output] })),
    ).resolves.toStrictEqual({ status: 'unavailable', reason: 'unparseable' });
  });

  it('treats a valid hidden-only catalogue as unavailable/empty', async () => {
    const output = JSON.stringify({
      models: [{ slug: 'gpt-reserve', visibility: 'hide' }],
    });
    await expect(
      listCodexModelCatalog('codex', makeSpawnImpl({ stdoutChunks: [output] })),
    ).resolves.toStrictEqual({ status: 'unavailable', reason: 'empty' });
  });

  it('preserves command failure classification', async () => {
    await expect(
      listCodexModelCatalog('codex', makeSpawnImpl({ exitCode: 2 })),
    ).resolves.toStrictEqual({ status: 'unavailable', reason: 'command-error' });
  });

  it('bounds output and terminates the child', async () => {
    const child = makeFakeChild({ stdoutChunks: ['x'.repeat(8 * 1024 * 1024 + 1)] });
    const spawnImpl = (() => child) as unknown as SpawnImpl;

    await expect(listCodexModelCatalog('codex', spawnImpl)).resolves.toStrictEqual({
      status: 'unavailable',
      reason: 'output-limit',
    });
    expect(child.kill).toHaveBeenCalled();
  });

  it('times out and terminates a wedged diagnostic command', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild({ neverCloses: true });
    const promise = listCodexModelCatalog('codex', (() => child) as unknown as SpawnImpl);
    await vi.advanceTimersByTimeAsync(5_001);

    await expect(promise).resolves.toStrictEqual({ status: 'unavailable', reason: 'timeout' });
    expect(child.kill).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
