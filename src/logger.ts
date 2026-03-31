import pino from 'pino';
import { join } from 'node:path';

const level = process.env.LOG_LEVEL ?? 'info';

// ─── File transport via pino-roll ─────────────────────────────────────────────
// Activated when LOG_DIR env var is set (always true in production via config/systemd).
// pino.transport() creates an async worker thread — writes are buffered and non-blocking.
// stdout continues to receive all log output (for journald), file is an additional sink.

// pino.transport() returns a Writable stream at runtime that also implements
// DestinationStream. We store it as `any` because the pino types don't expose
// the .on()/.end() methods needed for shutdown flush.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let transport: any;

const logDir = process.env.LOG_DIR;
if (logDir) {
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

const logger = transport ? pino({ level }, transport) : pino({ level });

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
