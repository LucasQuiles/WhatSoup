/**
 * #2239: the auth in-flight dedup belongs to one fleet server, not to the
 * module. Each deps object stands for one server (createFleetServer builds one
 * routeDeps and hands it to every route), so two separately built deps must
 * not see each other's auth sessions, while repeat requests to one server
 * still get the 409.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', async () => {
  const { childProcessMock } = await import('../../helpers/child-process.ts');
  return childProcessMock();
});

import { spawn } from 'node:child_process';
import { handleAuth } from '../../../src/fleet/routes/ops-auth.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import { makeDeps, mockReq, mockRes, mockSseRes } from '../../helpers/http-mocks.ts';

type AuthDeps = Parameters<typeof handleAuth>[2];

function fakeInstance(name: string): DiscoveredInstance {
  return {
    name,
    type: 'chat',
    accessMode: 'self_only',
    healthPort: 3010,
    dbPath: `/data/${name}/bot.db`,
    stateRoot: `/state/${name}`,
    logDir: `/data/${name}/logs`,
    healthToken: null,
    // Absent config reads as no accountScopeId, so the legacy SSE flow runs.
    configPath: `/nonexistent/${name}/config.json`,
    socketPath: null,
  };
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  child.once('exit', (code) => child.emit('close', code));
  return child;
}

function depsFor(inst: DiscoveredInstance): AuthDeps {
  return makeDeps({ discovery: { getInstance: vi.fn(() => inst), scan: vi.fn() } as any }) as unknown as AuthDeps;
}

async function startAuth(deps: AuthDeps, name: string) {
  const res = mockSseRes();
  await handleAuth(mockReq({ method: 'POST', url: `/api/lines/${name}/auth` }), res, deps, { name });
  return res;
}

describe('ops-auth session registry is per fleet server (#2239)', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
  });

  it('two independently built servers do not share auth-in-flight state', async () => {
    const inst = fakeInstance('registry-line');
    const childA = fakeChild();
    const childB = fakeChild();
    vi.mocked(spawn).mockReturnValueOnce(childA as any).mockReturnValueOnce(childB as any);
    const serverA = depsFor(inst);
    const serverB = depsFor(inst);

    const resA = await startAuth(serverA, 'registry-line');
    expect(resA._status).toBe(200);

    // A session in flight on server A must not block server B.
    const resB = await startAuth(serverB, 'registry-line');
    expect(resB._status).toBe(200);
    expect(spawn).toHaveBeenCalledTimes(2);

    childA.emit('exit', 0);
    childB.emit('exit', 0);
  });

  it('keeps the cross-request 409 dedup within one server', async () => {
    const inst = fakeInstance('dedup-line');
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as any);
    const server = depsFor(inst);

    const first = await startAuth(server, 'dedup-line');
    expect(first._status).toBe(200);

    const second = mockRes();
    await handleAuth(mockReq({ method: 'POST', url: '/api/lines/dedup-line/auth' }), second, server, { name: 'dedup-line' });
    expect(second._status).toBe(409);
    expect(JSON.parse(second._body).error).toMatch(/auth already in progress/);
    expect(spawn).toHaveBeenCalledTimes(1);

    // After the session ends, the same server accepts a new auth request.
    child.emit('exit', 0);
    const next = fakeChild();
    vi.mocked(spawn).mockReturnValue(next as any);
    const third = await startAuth(server, 'dedup-line');
    expect(third._status).toBe(200);
    next.emit('exit', 0);
  });
});
