import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { waitForExit, waitForMessage, waitForSocket } from './wait-for.ts';

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

  it('removes the message listener when the wait times out', async () => {
    vi.useFakeTimers();
    const ws = new EventEmitter();
    const promise = waitForMessage(ws, 5);
    const expectation = expect(promise).rejects.toThrow('message timeout');

    await vi.advanceTimersByTimeAsync(5);

    await expectation;
    expect(ws.listenerCount('message')).toBe(0);
  });

  it('resolves with the child process exit code and signal', async () => {
    const child = new EventEmitter();
    const promise = waitForExit(child);

    child.emit('exit', 0, null);

    await expect(promise).resolves.toEqual({ code: 0, signal: null });
  });

  it('removes the exit listener when the wait times out', async () => {
    vi.useFakeTimers();
    const child = new EventEmitter();
    const promise = waitForExit(child, 5);
    const expectation = expect(promise).rejects.toThrow('exit timeout');

    await vi.advanceTimersByTimeAsync(5);

    await expectation;
    expect(child.listenerCount('exit')).toBe(0);
  });
});
