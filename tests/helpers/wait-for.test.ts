import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { waitForMessage, waitForSocket } from './wait-for.ts';

const cleanupPaths: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const entry of cleanupPaths.splice(0)) {
    try {
      fs.rmSync(entry, { force: true, recursive: true });
    } catch {
      // best effort cleanup
    }
  }
});

describe('wait-for test helpers', () => {
  it('waits until a socket path exists', async () => {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-for-socket-'));
    cleanupPaths.push(dir);
    const socketPath = path.join(dir, 'server.sock');

    const promise = waitForSocket(socketPath, 200);
    fs.writeFileSync(socketPath, '');
    await vi.advanceTimersByTimeAsync(10);

    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects when a socket path never appears', async () => {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-for-socket-'));
    cleanupPaths.push(dir);
    const promise = waitForSocket(path.join(dir, 'missing.sock'), 5);
    const expectation = expect(promise).rejects.toThrow('never appeared');

    await vi.advanceTimersByTimeAsync(10);

    await expectation;
  });

  it('parses the next JSON message from an EventEmitter-style socket', async () => {
    const ws = new EventEmitter();
    const promise = waitForMessage<{ ok: true }>(ws);

    ws.emit('message', Buffer.from('{"ok":true}'));

    await expect(promise).resolves.toEqual({ ok: true });
  });
});
