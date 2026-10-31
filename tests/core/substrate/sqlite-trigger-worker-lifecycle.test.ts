import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, afterEach } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

import { runIsolatedSqlite } from '../../../src/core/substrate/poller.ts';

function fakeChild(): EventEmitter & {
  stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

const request = {
  databasePath: '/private/tmp/sqlite-trigger-worker-lifecycle.db',
  sql: 'SELECT 1',
  binds: [],
  maxRows: 1,
  timeoutMs: 1_000,
};

describe('runIsolatedSqlite child lifecycle', () => {
  afterEach(() => vi.resetAllMocks());

  it('does not resolve on a post-spawn error until the child closes', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const result = runIsolatedSqlite(request);
    let settled = false;
    void result.then(() => { settled = true; });

    child.emit('error', new Error('late spawn error'));
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit('close', 1);
    await expect(result).resolves.toEqual({ kind: 'unavailable', reason: 'spawn' });
  });

  it('returns a redacted unavailable result immediately when spawning throws synchronously', async () => {
    spawnMock.mockImplementation(() => { throw new Error('spawn unavailable'); });
    await expect(runIsolatedSqlite(request)).resolves.toEqual({ kind: 'unavailable', reason: 'spawn' });
  });
});
