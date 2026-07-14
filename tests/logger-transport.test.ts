/**
 * Coverage supplement for src/logger.ts — file-transport (LOG_DIR) path.
 *
 * Existing tests/logger.test.ts covers the no-transport path completely.
 * This file covers the eight uncovered statements / one uncovered branch:
 *
 *   stmt 1  (line 17) — `const logDir = process.env.LOG_DIR` evaluation when set
 *   stmt 5  (line 39) — catch handler (transport = undefined on pino.transport failure)
 *   stmt 6  (line 43) — `pino({ level }, transport)` branch (transport truthy)
 *   stmt 10 (lines 58-68) — flushLogger() body when transport IS active
 *   stmt 11 (line 60) — transport.on('close', resolve)
 *   stmt 12 (line 64) — logger.flush()
 *   stmt 13 (line 65) — transport.end()
 *   stmt 14 (line 67) — setTimeout(resolve, 2_000)
 *   branch 3[1] (line 57) — flushLogger() with transport present
 *
 * Strategy: mock pino at the module level so pino.transport() is controllable
 * without needing pino-roll installed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type LoggerModule = typeof import('../src/logger.ts');

const originalLogDir = process.env.LOG_DIR;
const originalLogLevel = process.env.LOG_LEVEL;
const originalVitest = process.env.VITEST;

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  // Restore env
  if (originalLogDir === undefined) delete process.env.LOG_DIR;
  else process.env.LOG_DIR = originalLogDir;
  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
  if (originalVitest === undefined) delete process.env.VITEST;
  else process.env.VITEST = originalVitest;
});

/**
 * Build a fake pino module where pino.transport() returns a controllable fake
 * stream. pino() with a transport arg returns a fake logger that exposes flush().
 */
function buildPinoMock(transportOpts: {
  throwOnTransport?: boolean;
  emitCloseImmediately?: boolean;
}) {
  const fakeFlush = vi.fn();
  const fakeTransportOn = vi.fn();
  const fakeTransportEnd = vi.fn();

  // Build fake transport stream
  const fakeTransport = {
    on: fakeTransportOn.mockImplementation((event: string, cb: () => void) => {
      if (event === 'close' && transportOpts.emitCloseImmediately) {
        // Simulate immediate close (so flushLogger resolves via close event, not timeout)
        setImmediate(cb);
      }
    }),
    end: fakeTransportEnd,
  };

  const fakeLogger = {
    level: 'info',
    child: vi.fn(() => fakeLogger),
    bindings: vi.fn(() => ({})),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    flush: fakeFlush,
  };

  const pinoFn = vi.fn((opts?: unknown, transport?: unknown) => {
    // When called with transport arg, return logger with flush
    if (transport) return fakeLogger;
    // No-transport path (plain stdout logger)
    return { ...fakeLogger, flush: vi.fn() };
  }) as unknown as ReturnType<typeof vi.fn> & {
    transport: ReturnType<typeof vi.fn>;
    stdSerializers: { err: ReturnType<typeof vi.fn> };
  };

  pinoFn.transport = vi.fn(() => {
    if (transportOpts.throwOnTransport) throw new Error('pino-roll unavailable');
    return fakeTransport;
  }) as unknown as typeof pinoFn.transport;

  pinoFn.stdSerializers = { err: vi.fn((e) => e) };

  return { pinoFn, fakeTransport, fakeLogger, fakeFlush, fakeTransportOn, fakeTransportEnd };
}

describe('logger.ts — LOG_DIR (file transport) path', () => {
  describe('when pino.transport() succeeds', () => {
    beforeEach(() => {
      process.env.LOG_DIR = '/tmp/ws-logs-test';
      delete process.env.VITEST;
      delete process.env.LOG_LEVEL;
    });

    it('creates a transport with two targets (stdout + pino-roll) and exports a pino logger', async () => {
      const { pinoFn, fakeTransport } = buildPinoMock({ emitCloseImmediately: true });
      vi.doMock('pino', () => ({ default: pinoFn }));

      const mod: LoggerModule = await import('../src/logger.ts');

      // pino.transport() was called once
      expect(pinoFn.transport).toHaveBeenCalledOnce();
      const transportArg = (pinoFn.transport as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        targets: Array<{ target: string; options?: Record<string, unknown> }>;
      };
      expect(transportArg.targets).toHaveLength(2);
      expect(transportArg.targets[0].target).toBe('pino/file');
      expect(transportArg.targets[1].target).toBe('pino-roll');
      expect(transportArg.targets[1].options).toMatchObject({
        file: '/tmp/ws-logs-test/whatsoup.log',
        frequency: 'daily',
        mkdir: true,
      });

      // pino() was called with the transport
      expect(pinoFn).toHaveBeenCalledWith(
        { level: 'info', serializers: { err: pinoFn.stdSerializers.err, error: pinoFn.stdSerializers.err } },
        fakeTransport,
      );

      // default export is a logger
      expect(typeof mod.default.info).toBe('function');
    });

    it('flushLogger() calls transport.on("close"), logger.flush(), transport.end(), and setTimeout', async () => {
      vi.useFakeTimers();
      const { pinoFn, fakeFlush, fakeTransportOn, fakeTransportEnd } = buildPinoMock({});
      vi.doMock('pino', () => ({ default: pinoFn }));

      const mod: LoggerModule = await import('../src/logger.ts');

      // Don't await — transport close won't emit in fake-timer env
      const flushPromise = mod.flushLogger();
      expect(flushPromise).toBeInstanceOf(Promise);

      // Safety timeout fires at 2000ms
      await vi.advanceTimersByTimeAsync(2_000);
      await flushPromise;

      expect(fakeTransportOn).toHaveBeenCalledWith('close', expect.any(Function));
      expect(fakeFlush).toHaveBeenCalledOnce();
      expect(fakeTransportEnd).toHaveBeenCalledOnce();

      vi.useRealTimers();
    });

    it('flushLogger() resolves via close event before the 2s safety timeout', async () => {
      const { pinoFn, fakeTransportOn, fakeTransportEnd } = buildPinoMock({
        emitCloseImmediately: true,
      });
      vi.doMock('pino', () => ({ default: pinoFn }));

      const mod: LoggerModule = await import('../src/logger.ts');

      const start = Date.now();
      await mod.flushLogger();
      // close event fired via setImmediate — should resolve well under 2000ms
      expect(Date.now() - start).toBeLessThan(1_500);
      expect(fakeTransportOn).toHaveBeenCalledWith('close', expect.any(Function));
      expect(fakeTransportEnd).toHaveBeenCalledOnce();
    });

    it('LOG_LEVEL env is forwarded to transport target levels and pino opts', async () => {
      process.env.LOG_LEVEL = 'debug';
      const { pinoFn } = buildPinoMock({ emitCloseImmediately: true });
      vi.doMock('pino', () => ({ default: pinoFn }));

      await import('../src/logger.ts');

      const transportArg = (pinoFn.transport as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        targets: Array<{ level: string }>;
      };
      expect(transportArg.targets[0].level).toBe('debug');
      expect(transportArg.targets[1].level).toBe('debug');
      // pino() opts level
      expect((pinoFn as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ level: 'debug' });
    });
  });

  describe('when pino.transport() throws (pino-roll unavailable)', () => {
    beforeEach(() => {
      process.env.LOG_DIR = '/tmp/ws-logs-test';
      delete process.env.VITEST;
    });

    it('catches the error, sets transport to undefined, and falls back to stdout-only pino', async () => {
      const { pinoFn } = buildPinoMock({ throwOnTransport: true });
      vi.doMock('pino', () => ({ default: pinoFn }));

      const mod: LoggerModule = await import('../src/logger.ts');

      // transport threw — pino() is called without a transport arg (stdout-only path)
      const callsWithTransport = (pinoFn as ReturnType<typeof vi.fn>).mock.calls.filter(
        (args) => args.length === 2 && args[1] !== undefined,
      );
      expect(callsWithTransport).toHaveLength(0);

      // Module still exports a functional logger
      expect(typeof mod.default.info).toBe('function');
    });

    it('flushLogger() resolves immediately (no-op) when transport is undefined after catch', async () => {
      const { pinoFn } = buildPinoMock({ throwOnTransport: true });
      vi.doMock('pino', () => ({ default: pinoFn }));

      const mod: LoggerModule = await import('../src/logger.ts');
      const start = Date.now();
      await mod.flushLogger();
      expect(Date.now() - start).toBeLessThan(100);
    });
  });
});
