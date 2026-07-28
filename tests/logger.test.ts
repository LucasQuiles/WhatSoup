/**
 * Direct unit coverage for src/logger.ts.
 *
 * The module exposes:
 * - default `logger` (pino instance configured from LOG_LEVEL + LOG_DIR env)
 * - `createChildLogger(name)` — child logger with `{ component: name }` binding
 * - `flushLogger()` — async flush helper for graceful shutdown
 *
 * 78 test files import from this module indirectly; no direct mirror test
 * exists. This file pins the public-API surface: child-logger contract,
 * flush behavior when no file transport is active, and the default logger's
 * structural shape.
 *
 * src/logger.ts reads LOG_DIR at module evaluation time, so each test imports
 * it only after setting the intended environment and resetting Vitest's module
 * cache. That keeps these no-transport assertions stable even when the parent
 * test process starts with LOG_DIR set.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

type LoggerModule = typeof import('../src/logger');

interface MockTransport {
  end: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

interface MockLogger {
  child: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  fatal: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  level: string;
  trace: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
}

const originalLogDir = process.env.LOG_DIR;
const originalLogLevel = process.env.LOG_LEVEL;
const originalVitest = process.env.VITEST;

async function importLoggerWithoutFileTransport(): Promise<LoggerModule> {
  vi.resetModules();
  delete process.env.LOG_DIR;
  delete process.env.LOG_LEVEL;
  return import('../src/logger');
}

function createMockLogger(level = process.env.LOG_LEVEL ?? 'info'): MockLogger {
  return {
    child: vi.fn((bindings: Record<string, unknown>) => ({
      ...createMockLogger(level),
      bindings: () => bindings,
    })),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    flush: vi.fn(),
    info: vi.fn(),
    level,
    trace: vi.fn(),
    warn: vi.fn(),
  };
}

async function importLoggerWithMockedPino(options: {
  logDir?: string;
  logLevel?: string;
  transport?: MockTransport;
  transportThrows?: boolean;
}): Promise<{
  loggerModule: LoggerModule;
  logger: MockLogger;
  pinoFactory: ReturnType<typeof vi.fn>;
  transportFactory: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();
  if (options.logDir === undefined) delete process.env.LOG_DIR;
  else process.env.LOG_DIR = options.logDir;
  if (options.logLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = options.logLevel;
  delete process.env.VITEST;

  const logger = createMockLogger(options.logLevel ?? 'info');
  const transportFactory = vi.fn(() => {
    if (options.transportThrows) throw new Error('transport unavailable');
    return options.transport;
  });
  const pinoFactory = vi.fn(() => logger);
  Object.assign(pinoFactory, { transport: transportFactory, stdSerializers: { err: vi.fn((e) => e) } });
  vi.doMock('pino', () => ({ default: pinoFactory }));

  return {
    loggerModule: await import('../src/logger'),
    logger,
    pinoFactory,
    transportFactory,
  };
}

afterEach(() => {
  vi.doUnmock('pino');
  vi.resetModules();
  vi.useRealTimers();
  if (originalVitest === undefined) delete process.env.VITEST;
  else process.env.VITEST = originalVitest;
});

afterAll(() => {
  if (originalLogDir === undefined) {
    delete process.env.LOG_DIR;
  } else {
    process.env.LOG_DIR = originalLogDir;
  }

  if (originalLogLevel === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = originalLogLevel;
  }
});

describe('default logger', () => {
  it('exposes the standard pino API surface (info/warn/error/debug/fatal/trace/child)', async () => {
    const { default: logger } = await importLoggerWithoutFileTransport();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.fatal).toBe('function');
    expect(typeof logger.trace).toBe('function');
    expect(typeof logger.child).toBe('function');
  });

  it('has a configured log level (string, from LOG_LEVEL env or default "info")', async () => {
    const { default: logger } = await importLoggerWithoutFileTransport();
    expect(typeof logger.level).toBe('string');
    expect(logger.level.length).toBeGreaterThan(0);
  });
});

describe('createChildLogger', () => {
  it('returns a child logger with the component binding set to the requested name', async () => {
    const { createChildLogger } = await importLoggerWithoutFileTransport();
    const child = createChildLogger('test-component');
    expect(child.bindings()).toEqual({ component: 'test-component' });
  });

  it('child loggers inherit the parent log level', async () => {
    const { createChildLogger, default: logger } = await importLoggerWithoutFileTransport();
    const child = createChildLogger('test-component');
    expect(child.level).toBe(logger.level);
  });

  it('child loggers expose the standard pino API surface', async () => {
    const { createChildLogger } = await importLoggerWithoutFileTransport();
    const child = createChildLogger('test-component');
    expect(typeof child.info).toBe('function');
    expect(typeof child.warn).toBe('function');
    expect(typeof child.error).toBe('function');
  });

  it('two distinct names produce distinct bindings', async () => {
    const { createChildLogger } = await importLoggerWithoutFileTransport();
    const a = createChildLogger('alpha');
    const b = createChildLogger('beta');
    expect(a.bindings()).toEqual({ component: 'alpha' });
    expect(b.bindings()).toEqual({ component: 'beta' });
  });

  it('calling info/warn/error does not throw with structured payload', async () => {
    const { createChildLogger } = await importLoggerWithoutFileTransport();
    const child = createChildLogger('throw-check');
    expect(() => child.info({ field: 'value' }, 'message')).not.toThrow();
    expect(() => child.warn('plain string')).not.toThrow();
    expect(() => child.error(new Error('boom'), 'with error')).not.toThrow();
  });
});

describe('flushLogger', () => {
  it('returns a Promise', async () => {
    const { flushLogger } = await importLoggerWithoutFileTransport();
    const result = flushLogger();
    expect(result).toBeInstanceOf(Promise);
    return result;
  });

  it('resolves promptly when no file transport is active', async () => {
    const { flushLogger } = await importLoggerWithoutFileTransport();
    // LOG_DIR is cleared before import, so `transport` is undefined and
    // flushLogger() returns Promise.resolve(). This must complete in under
    // 100ms, well under the 2000ms safety timeout the implementation uses
    // when an actual transport is present.
    const start = Date.now();
    await flushLogger();
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(100);
  });

  it('safe to call repeatedly (idempotent) — each call returns a distinct fresh Promise', async () => {
    const { flushLogger } = await importLoggerWithoutFileTransport();
    const p1 = flushLogger();
    const p2 = flushLogger();
    const p3 = flushLogger();
    // Each invocation returns its own Promise (factory, not memoized).
    expect(p1).not.toBe(p2);
    expect(p2).not.toBe(p3);
    expect(p1).toBeInstanceOf(Promise);
    expect(p2).toBeInstanceOf(Promise);
    expect(p3).toBeInstanceOf(Promise);
    // All three resolve within the no-transport fast path (<100ms total).
    const start = Date.now();
    await Promise.all([p1, p2, p3]);
    expect(Date.now() - start).toBeLessThan(100);
  });
});

describe('file transport configuration', () => {
  it.each(['true', 'false'])(
    'does not start an async file transport when VITEST is present (%s)',
    async (vitestValue) => {
      vi.resetModules();
      process.env.VITEST = vitestValue;
      process.env.LOG_DIR = '/tmp/whatsoup-logs';
      const logger = createMockLogger();
      const transportFactory = vi.fn();
      const stdErrSerializer = vi.fn((e) => e);
      const pinoFactory = vi.fn(() => logger);
      Object.assign(pinoFactory, { transport: transportFactory, stdSerializers: { err: stdErrSerializer } });
      vi.doMock('pino', () => ({ default: pinoFactory }));

      await import('../src/logger');

      expect(transportFactory).not.toHaveBeenCalled();
      expect(pinoFactory).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'info',
          serializers: { err: stdErrSerializer, error: stdErrSerializer },
        }),
      );
    },
  );

  it('keeps file transport enabled when VITEST is absent', async () => {
    vi.resetModules();
    delete process.env.VITEST;
    process.env.LOG_DIR = '/tmp/whatsoup-logs';
    const logger = createMockLogger();
    const transport = { end: vi.fn(), on: vi.fn() };
    const transportFactory = vi.fn(() => transport);
    const stdErrSerializer = vi.fn((e) => e);
    const pinoFactory = vi.fn(() => logger);
    Object.assign(pinoFactory, { transport: transportFactory, stdSerializers: { err: stdErrSerializer } });
    vi.doMock('pino', () => ({ default: pinoFactory }));

    await import('../src/logger');

    expect(transportFactory).toHaveBeenCalledOnce();
    expect(pinoFactory).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info', serializers: { err: stdErrSerializer, error: stdErrSerializer } }),
      transport,
    );
  });

  it('creates stdout and rolling-file targets when LOG_DIR is set', async () => {
    const logDir = '/tmp/whatsoup-logs';
    const transport: MockTransport = { end: vi.fn(), on: vi.fn() };
    const { loggerModule, pinoFactory, transportFactory } = await importLoggerWithMockedPino({
      logDir,
      logLevel: 'debug',
      transport,
    });

    expect(transportFactory).toHaveBeenCalledWith({
      targets: [
        { target: 'pino/file', options: { destination: 1 }, level: 'debug' },
        {
          target: 'pino-roll',
          options: {
            file: join(logDir, 'whatsoup.log'),
            frequency: 'daily',
            mkdir: true,
            limit: { count: 10 },
          },
          level: 'debug',
        },
      ],
    });
    const stdErrSerializer = (pinoFactory as unknown as { stdSerializers: { err: unknown } }).stdSerializers.err;
    expect(pinoFactory).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'debug', serializers: { err: stdErrSerializer, error: stdErrSerializer } }),
      transport,
    );
    expect(loggerModule.default.level).toBe('debug');
  });

  it('falls back to stdout-only logging if transport setup fails', async () => {
    const { loggerModule, logger, pinoFactory, transportFactory } = await importLoggerWithMockedPino({
      logDir: '/tmp/invalid-log-dir',
      logLevel: 'warn',
      transportThrows: true,
    });

    await loggerModule.flushLogger();

    const stdErrSerializer = (pinoFactory as unknown as { stdSerializers: { err: unknown } }).stdSerializers.err;
    expect(transportFactory).toHaveBeenCalledOnce();
    expect(pinoFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        serializers: { err: stdErrSerializer, error: stdErrSerializer },
      }),
    );
    expect(logger.flush).not.toHaveBeenCalled();
    expect(loggerModule.default.level).toBe('warn');
  });
});

describe('flushLogger with file transport', () => {
  it('flushes the logger, ends the transport, and resolves on close', async () => {
    let onClose: (() => void) | undefined;
    const transport: MockTransport = {
      end: vi.fn(),
      on: vi.fn((event: string, listener: () => void) => {
        if (event === 'close') onClose = listener;
        return transport;
      }),
    };
    const { loggerModule, logger } = await importLoggerWithMockedPino({
      logDir: '/tmp/whatsoup-logs',
      transport,
    });

    const result = loggerModule.flushLogger();

    expect(transport.on).toHaveBeenCalledWith('close', expect.any(Function));
    expect(logger.flush).toHaveBeenCalledOnce();
    expect(transport.end).toHaveBeenCalledOnce();
    expect(onClose).toBeDefined();
    onClose?.();
    await expect(result).resolves.toBeUndefined();
  });

  it('resolves via the safety timeout if the transport never closes', async () => {
    vi.useFakeTimers();
    const transport: MockTransport = {
      end: vi.fn(),
      on: vi.fn(() => transport),
    };
    const { loggerModule, logger } = await importLoggerWithMockedPino({
      logDir: '/tmp/whatsoup-logs',
      transport,
    });

    const result = loggerModule.flushLogger();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(logger.flush).toHaveBeenCalledOnce();
    expect(transport.end).toHaveBeenCalledOnce();
    await expect(result).resolves.toBeUndefined();
  });
});
