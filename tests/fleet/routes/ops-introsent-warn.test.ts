/**
 * Re-auth introSent reset: a failed config rewrite after the auth process
 * reports `connected` must be logged at warn — it was the only unlogged
 * failure in the flow, leaving operators no clue why the instance never
 * re-introduced itself after pairing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ServerResponse } from 'node:http';

const { mockLogWarn } = vi.hoisted(() => ({ mockLogWarn: vi.fn() }));

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: mockLogWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock('../../../src/fleet/mcp-client.ts', () => ({
  mcpCall: vi.fn(),
}));
vi.mock('../../../src/fleet/http-proxy.ts', () => ({
  proxyToInstance: vi.fn(),
}));
vi.mock('node:child_process', async () => {
  const { childProcessMock } = await import('../../helpers/child-process.ts');
  return childProcessMock();
});

import { handleAuth } from '../../../src/fleet/routes/ops.ts';
import type { OpsDeps } from '../../../src/fleet/routes/ops.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import { privateConfigLockPath } from '../../../src/core/private-config-file.ts';
import { acquireProcessLock, releaseProcessLock } from '../../../src/lib/process-lock.ts';
import { spawn } from 'node:child_process';
import { mockReq } from '../../helpers/http-mocks.ts';

function mockSseRes(): ServerResponse & { _chunks: string[]; _ended: boolean } {
  const res = {
    _status: 0,
    _headers: {} as Record<string, string>,
    _chunks: [] as string[],
    _ended: false,
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
    },
    write(chunk: string) {
      res._chunks.push(chunk);
      return true;
    },
    end(data?: string) {
      if (data) res._chunks.push(data);
      res._ended = true;
    },
    // ServerResponse is an EventEmitter; createSSEWriter attaches an 'error'
    // listener (#2292 L7), so a fake without `on` is an incomplete fake.
    on() {
      return res;
    },
  };
  return res as unknown as ServerResponse & { _chunks: string[]; _ended: boolean };
}

function fakeInstance(overrides: Partial<DiscoveredInstance> = {}): DiscoveredInstance {
  return {
    name: 'test-line',
    type: 'chat',
    accessMode: 'self_only',
    healthPort: 3010,
    dbPath: '/data/test-line/bot.db',
    stateRoot: '/state/test-line',
    logDir: '/data/test-line/logs',
    healthToken: 'tok123',
    configPath: '/nonexistent-introsent-dir/config.json',
    socketPath: null,
    ...overrides,
  } as DiscoveredInstance;
}

function makeDeps(instance: DiscoveredInstance): OpsDeps {
  return {
    discovery: {
      getInstance: vi.fn(() => instance),
      getInstances: vi.fn(() => new Map()),
      scan: vi.fn(),
    },
    realtime: { publish: vi.fn() },
    serviceManager: {
      enable: vi.fn().mockResolvedValue(undefined),
      disable: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      restart: vi.fn().mockResolvedValue(undefined),
      // The deferred post-auth start passes a completion callback; invoking it
      // lets the SSE flow finish (endOnce) so authInFlight is released between
      // tests.
      startFire: vi.fn((_name: string, onComplete?: (err: Error | null) => void) => onComplete?.(null)),
    },
  } as unknown as OpsDeps;
}

describe('handleAuth introSent reset failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('warns when the introSent config rewrite fails after auth connects', async () => {
    const instance = fakeInstance();
    const deps = makeDeps(instance);
    const req = mockReq({ method: 'POST', url: '/api/lines/test-line/auth' });
    const res = mockSseRes();

    const pending = handleAuth(req, res, deps, { name: 'test-line' });

    await vi.waitFor(() => expect(vi.mocked(spawn)).toHaveBeenCalled());
    const child = vi.mocked(spawn).mock.results[0]!.value as {
      stdout: { emit: (event: string, chunk: Buffer) => void };
      emit: (event: string, code: number) => void;
    };

    // The auth process reports connected; the configPath directory does not
    // exist, so the introSent rewrite throws inside the handler.
    child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'connected' }) + '\n'));

    await vi.waitFor(() => {
      const warned = mockLogWarn.mock.calls.some(
        ([ctx, msg]) =>
          typeof msg === 'string'
          && msg.includes('introSent')
          && typeof ctx === 'object'
          && ctx !== null
          && (ctx as Record<string, unknown>).instance === 'test-line'
          // The err binding is the point of the fix — operators need the
          // underlying failure, not just that one happened.
          && (ctx as Record<string, unknown>).err !== undefined,
      );
      expect(warned).toBe(true);
    });

    // The start is deferred until the pairing helper's successful completion:
    // `connected` on stdout only proves persisted credentials, so nothing may
    // start before the child's `close`.
    expect(deps.serviceManager.startFire).not.toHaveBeenCalled();

    // The flow must still proceed: once the helper closes cleanly, the
    // post-auth start fires despite the config write failure.
    child.emit('exit', 0);
    child.emit('close', 0);
    expect(deps.serviceManager.startFire).toHaveBeenCalled();
    await pending;
  });

  it('warns and continues when the introSent reset is blocked by the config mutation lock', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-auth-lock-'));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ name: 'test-line', introSent: true }, null, 2) + '\n');
    fs.chmodSync(configPath, 0o600);
    const lock = acquireProcessLock(privateConfigLockPath(configPath), { token: 'held-auth-lock' });

    try {
      const instance = fakeInstance({ configPath });
      const deps = makeDeps(instance);
      const req = mockReq({ method: 'POST', url: '/api/lines/test-line/auth' });
      const res = mockSseRes();

      const pending = handleAuth(req, res, deps, { name: 'test-line' });

      await vi.waitFor(() => expect(vi.mocked(spawn)).toHaveBeenCalled());
      const child = vi.mocked(spawn).mock.results[0]!.value as {
        stdout: { emit: (event: string, chunk: Buffer) => void };
        emit: (event: string, code: number) => void;
      };

      child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'connected' }) + '\n'));

      await vi.waitFor(() => {
        const warned = mockLogWarn.mock.calls.some(
          ([ctx, msg]) =>
            typeof msg === 'string'
            && msg.includes('introSent')
            && typeof ctx === 'object'
            && ctx !== null
            && (ctx as Record<string, unknown>).err instanceof Error
            && ((ctx as Record<string, unknown>).err as Error).message.includes('process lock active'),
        );
        expect(warned).toBe(true);
      });

      expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).introSent).toBe(true);
      // Deferred-start contract: nothing starts until the helper closes.
      expect(deps.serviceManager.startFire).not.toHaveBeenCalled();

      child.emit('exit', 0);
      child.emit('close', 0);
      expect(deps.serviceManager.startFire).toHaveBeenCalled();
      await pending;
    } finally {
      releaseProcessLock(lock);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
