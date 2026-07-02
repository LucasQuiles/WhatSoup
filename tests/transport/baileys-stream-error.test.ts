// tests/transport/baileys-stream-error.test.ts
// Verifies that createMediaReadStream (in src/transport/baileys-media-errors.ts)
// attaches a synchronous 'error' listener so a race-deleted file does NOT
// raise an uncaughtException before undici's body-consumer attaches.
//
// Production crash signature (2026-05-18 17:12:22 EDT):
//   ENOENT: no such file or directory, open '/tmp/user/1000/document<hex>-enc'
//   → uncaughtException → global handler triggers shutdown

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import type { Logger } from 'pino';
import { createMediaReadStream } from '../../src/transport/baileys-media-errors.ts';

// ─── Test infrastructure ──────────────────────────────────────────────────────

let uncaughtCalled = false;
let uncaughtErr: Error | undefined;

function uncaughtListener(err: Error) {
  uncaughtCalled = true;
  uncaughtErr = err;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStubLog(): { log: Logger; warned: Array<{ err: unknown; path: string; msg: string }> } {
  const warned: Array<{ err: unknown; path: string; msg: string }> = [];
  const log = {
    error: vi.fn((obj: { err: unknown; path: string }, msg: string) => {
      warned.push({ ...obj, msg });
    }),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: () => log,
  } as unknown as Logger;
  return { log, warned };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('createMediaReadStream — race-delete safety', () => {
  let tmpDir: string;

  beforeEach(() => {
    uncaughtCalled = false;
    uncaughtErr = undefined;
    process.once('uncaughtException', uncaughtListener);
    tmpDir = mkdtempSync(join(tmpdir(), 'ws-stream-test-'));
  });

  afterEach(() => {
    process.removeListener('uncaughtException', uncaughtListener);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Test 1: listener attached synchronously before any await ───────────────
  it('attaches an error listener synchronously at stream creation time', () => {
    expect.assertions(1);

    const filePath = join(tmpDir, 'document-enc');
    writeFileSync(filePath, 'fake-payload');

    const { log } = makeStubLog();
    const stream = createMediaReadStream(filePath, tmpDir, log);

    // Listener count must be >0 at THIS point — before caller does anything
    expect(stream.listenerCount('error')).toBeGreaterThan(0);

    // Clean up — attach caller listener before destroying so we suppress
    stream.on('error', () => {});
    stream.destroy();
  });

  // ── Test 2: race-delete does NOT produce uncaughtException ─────────────────
  it('does not raise uncaughtException when the file is deleted before stream is consumed', async () => {
    expect.assertions(5);

    const filePath = join(tmpDir, 'document3EB0DA6BF316F42701A08F-enc');
    writeFileSync(filePath, 'fake-enc-payload');

    const { log, warned } = makeStubLog();
    const stream = createMediaReadStream(filePath, tmpDir, log);

    // Simulate Baileys race: unlink the tempfile before the stream body is read
    unlinkSync(filePath);

    // Wait for the 'error' event to arrive on the stream (the caller-facing event).
    // This uses node:events once() — no sleeps, no timeouts.
    const [err] = await once(stream, 'error');

    // The error should be the ENOENT we caused
    expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');

    // The uncaughtException handler must NOT have been called
    expect(uncaughtCalled).toBe(false);
    expect(uncaughtErr).toBeUndefined();

    // The internal listener must have logged the exact path that failed —
    // not just "something" was logged, the right thing was logged.
    expect(warned).toHaveLength(1);
    expect((warned[0].err as NodeJS.ErrnoException).path).toBe(filePath);
  });

  // ── Test 3: caller can still observe the error after suppression ───────────
  it('allows caller to attach their own error listener and see the failure', async () => {
    expect.assertions(3);

    const filePath = join(tmpDir, 'image-enc');
    writeFileSync(filePath, 'fake-image-payload');

    const { log } = makeStubLog();
    const stream = createMediaReadStream(filePath, tmpDir, log);

    // Caller attaches their own listener (simulating retry logic)
    const callerErrors: Error[] = [];
    stream.on('error', (e) => callerErrors.push(e));

    // Delete file to trigger ENOENT
    unlinkSync(filePath);

    // Wait for caller's error listener to fire
    await once(stream, 'error');

    expect(callerErrors).toHaveLength(1);
    expect((callerErrors[0] as NodeJS.ErrnoException).code).toBe('ENOENT');
    expect((callerErrors[0] as NodeJS.ErrnoException).path).toBe(filePath);
  });
});
