import pino from 'pino';
import { join } from 'node:path';
import { sanitizingLogHook } from './lib/log-sanitizer.ts';

const level = process.env.LOG_LEVEL ?? 'info';

// Pino's default serializers only cover the `err` key (WhatSoup's own
// logging convention). Third-party code we don't own — e.g. Baileys, which
// logs `logger.error({ error }, ...)` (node_modules/@whiskeysockets/baileys/
// lib/Utils/auth-utils.js) — uses the `error` key instead. Without a
// serializer for it, an Error's message/stack (non-enumerable) are dropped
// by plain JSON.stringify(), producing `error: {}` and erasing the failure
// cause (#1776). Registering pino's std error serializer under both keys
// covers our convention and theirs at this single seam, rather than
// patching call sites we don't own.
export const errorLikeSerializers = { err: pino.stdSerializers.err, error: pino.stdSerializers.err };

// ─── File transport via pino-roll ─────────────────────────────────────────────
// Activated when LOG_DIR env var is set (always true in production via config/systemd).
// pino.transport() creates an async worker thread — writes are buffered and non-blocking.
// stdout continues to receive all log output (for journald), file is an additional sink.

// pino.transport() returns a Writable stream at runtime that also implements
// DestinationStream. We store it as `any` because the pino types don't expose
// the .on()/.end() methods needed for shutdown flush.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pino.transport() returns a Writable stream exposing runtime .on()/.end() methods that are not in pino's TypeScript definitions; needed for shutdown flush expires 2026-12-31
let transport: any;

const logDir = process.env.LOG_DIR;
// Vitest removes its per-file HOME after each suite. Starting pino's worker
// transport there races that teardown, so Vitest stays stdout-only.
const fileTransportEnabled = !process.env.VITEST;
if (logDir && fileTransportEnabled) {
  try {
    transport = pino.transport({
      targets: [
        // stdout — always present (captured by systemd/journald)
        { target: 'pino/file', options: { destination: 1 }, level },
        // rolling file — daily rotation, keep 10 files
        {
          target: 'pino-roll',
          options: {
            file: join(logDir, 'whatsoup.log'),
            frequency: 'daily',
            mkdir: true,
            limit: { count: 10 },
          },
          level,
        },
      ],
    });
  } catch {
    // pino-roll not available or logDir invalid — fall back to stdout only
    transport = undefined;
  }
}

// WS-A06: the same recursive pre-sink sanitizer applies to both construction
// paths so every sink (stdout, rolling-file, third-party child logger) receives
// sanitized payloads. The hook intercepts at the API boundary, before Pino's
// serialization pipeline.
const baseOptions: pino.LoggerOptions = {
  level,
  serializers: errorLikeSerializers,
  hooks: {
    logMethod: sanitizingLogHook,
  } as pino.LoggerOptions['hooks'],
};

const logger = transport
  ? pino(baseOptions, transport)
  : pino(baseOptions);

export default logger;

export function createChildLogger(name: string) {
  return logger.child({ component: name });
}

/**
 * Flush the async transport and wait for it to close.
 * Call this during shutdown before process.exit() to avoid losing buffered log lines.
 * No-op if no file transport is active.
 */
export function flushLogger(): Promise<void> {
  if (!transport) return Promise.resolve();
  return new Promise<void>((resolve) => {
    // pino transport streams emit 'close' when fully flushed
    transport.on('close', resolve);
    // Drain pino's in-process ring buffer to the worker thread before signalling stop.
    // Without this, log lines buffered in pino's internal buffer at the moment
    // transport.end() is called may be silently dropped.
    logger.flush();
    transport.end();
    // Safety timeout — don't block shutdown forever
    setTimeout(resolve, 2_000);
  });
}
