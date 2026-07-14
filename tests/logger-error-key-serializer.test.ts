/**
 * Regression coverage for #1776: third-party errors logged under the
 * `error` key (Baileys' convention — see auth-utils.js:257) serialize to
 * `{}` because pino's default serializers only cover the `err` key
 * (WhatSoup's own convention). message/stack are non-enumerable on Error,
 * so plain JSON.stringify() on an unserialized Error yields `{}`, erasing
 * the failure cause.
 *
 * Two-part proof:
 *  - "round-trips through real pino" builds an actual pino instance with
 *    src/logger.ts's exported serializer config and a controllable stream
 *    destination, proving the config itself makes message/stack survive.
 *  - "wires the serializer into both pino() construction branches" mocks
 *    pino (matching the existing tests/logger.test.ts convention, since
 *    pino's default no-arg destination writes via a raw fd and can't be
 *    captured through process.stdout.write) and pins that src/logger.ts
 *    actually passes that config into both the transport and no-transport
 *    pino() calls.
 */
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';

const originalLogDir = process.env.LOG_DIR;
const originalLogLevel = process.env.LOG_LEVEL;
const originalVitest = process.env.VITEST;

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('pino');
  if (originalLogDir === undefined) delete process.env.LOG_DIR;
  else process.env.LOG_DIR = originalLogDir;
  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
  if (originalVitest === undefined) delete process.env.VITEST;
  else process.env.VITEST = originalVitest;
});

function captureStream(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('logger.ts — error-key serialization (#1776)', () => {
  describe('round-trips through real pino', () => {
    it('serializes an Error logged under the third-party `error` key to message/stack, not {}', async () => {
      const { errorLikeSerializers } = await import('../src/logger.ts');
      const capture = captureStream();
      const testLogger = pino({ serializers: errorLikeSerializers }, capture.stream);

      testLogger.error({ error: new Error('transaction failed, rolling back') }, 'baileys failure');
      const [entry] = capture.lines();

      expect(entry.error).toBeDefined();
      expect(entry.error).not.toEqual({});
      expect((entry.error as { message?: string }).message).toBe('transaction failed, rolling back');
      expect(typeof (entry.error as { stack?: string }).stack).toBe('string');
    });

    it('still serializes the WhatSoup convention `err` key (regression guard)', async () => {
      const { errorLikeSerializers } = await import('../src/logger.ts');
      const capture = captureStream();
      const testLogger = pino({ serializers: errorLikeSerializers }, capture.stream);

      testLogger.error({ err: new Error('own convention failure') }, 'internal failure');
      const [entry] = capture.lines();

      expect((entry.err as { message?: string }).message).toBe('own convention failure');
      expect(typeof (entry.err as { stack?: string }).stack).toBe('string');
    });
  });

  describe('wires the serializer into both pino() construction branches', () => {
    it('passes errorLikeSerializers when no file transport is active (stdout-only branch)', async () => {
      vi.resetModules();
      delete process.env.LOG_DIR;
      delete process.env.LOG_LEVEL;
      const fakeLogger = { child: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), level: 'info' };
      const pinoFactory = vi.fn(() => fakeLogger) as unknown as typeof pino & {
        stdSerializers: { err: ReturnType<typeof vi.fn> };
      };
      pinoFactory.stdSerializers = { err: vi.fn((e) => e) };
      vi.doMock('pino', () => ({ default: pinoFactory }));

      const { errorLikeSerializers } = await import('../src/logger.ts');

      // Guard against a vacuous pass: toHaveBeenCalledWith would deep-equal
      // `{ level: 'info' }` against `{ level: 'info', serializers: undefined }`,
      // so an absent export must fail here, not silently match below.
      expect(typeof errorLikeSerializers?.err).toBe('function');
      expect(typeof errorLikeSerializers?.error).toBe('function');
      expect(pinoFactory).toHaveBeenCalledWith({ level: 'info', serializers: errorLikeSerializers });
    });

    it('passes errorLikeSerializers when a file transport is active', async () => {
      vi.resetModules();
      process.env.LOG_DIR = '/tmp/ws-logs-error-key-test';
      delete process.env.VITEST;
      const fakeTransport = { on: vi.fn(), end: vi.fn() };
      const fakeLogger = { child: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), level: 'info' };
      const pinoFactory = vi.fn(() => fakeLogger) as unknown as typeof pino & {
        transport: ReturnType<typeof vi.fn>;
        stdSerializers: { err: ReturnType<typeof vi.fn> };
      };
      pinoFactory.transport = vi.fn(() => fakeTransport);
      pinoFactory.stdSerializers = { err: vi.fn((e) => e) };
      vi.doMock('pino', () => ({ default: pinoFactory }));

      const { errorLikeSerializers } = await import('../src/logger.ts');

      expect(typeof errorLikeSerializers?.err).toBe('function');
      expect(typeof errorLikeSerializers?.error).toBe('function');
      expect(pinoFactory).toHaveBeenCalledWith({ level: 'info', serializers: errorLikeSerializers }, fakeTransport);
    });
  });

  describe('child loggers', () => {
    it('a child logger (e.g. the baileys component logger) inherits the error-key serializer', async () => {
      const { errorLikeSerializers } = await import('../src/logger.ts');
      const capture = captureStream();
      const testLogger = pino({ serializers: errorLikeSerializers }, capture.stream);
      const child = testLogger.child({ component: 'baileys' });

      child.error({ error: new Error('child-scoped failure') }, 'transaction failed, rolling back');
      const [entry] = capture.lines();

      expect((entry.error as { message?: string }).message).toBe('child-scoped failure');
      expect(typeof (entry.error as { stack?: string }).stack).toBe('string');
    });
  });
});
