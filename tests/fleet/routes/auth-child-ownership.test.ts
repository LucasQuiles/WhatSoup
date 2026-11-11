import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mockChildProcess } from '../../helpers/child-process.ts';
import { makeDeps, mockReq, mockRes, mockSseRes } from '../../helpers/http-mocks.ts';
import { trackTmpDirs } from '../../helpers/tmp-dir.ts';
import type { OpsDeps } from '../../../src/fleet/routes/ops.ts';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(), spawn: spawnMock,
}));
const tmp = trackTmpDirs('auth-child-ownership-');
const children: ReturnType<typeof mockChildProcess>[] = [];
const routeDeps: OpsDeps[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  children.length = 0;
  routeDeps.length = 0;
  spawnMock.mockReset().mockImplementation(() => {
    const child = mockChildProcess();
    children.push(child);
    return child;
  });
});
afterEach(() => {
  for (const deps of routeDeps) vi.mocked(deps.serviceManager.startFire).mockImplementation((_name, callback) => callback?.(new Error('fixture shutdown')));
  for (const child of children) child.emit('close', 1);
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function setup() {
  const { handleAuth } = await import('../../../src/fleet/routes/ops-auth.ts');
  const configPath = join(tmp.make('instance'), 'config.json');
  writeFileSync(configPath, '{}');
  const deps = makeDeps({ discovery: { getInstance: () => ({ name: 'line-a', configPath }) } }) as unknown as OpsDeps;
  routeDeps.push(deps);
  const invoke = async () => {
    const req = mockReq({ method: 'GET' });
    const res = mockSseRes();
    await handleAuth(req, res, deps, { name: 'line-a' });
    return { req, res };
  };
  const expectBusy = async () => {
    const res = mockRes();
    await handleAuth(mockReq({ method: 'GET' }), res, deps, { name: 'line-a' });
    expect(res._status).toBe(409);
  };
  return { deps, invoke, expectBusy, configPath };
}

describe('authentication helper ownership', () => {
  it('releases in-memory admission after the durable claim cannot be created', async () => {
    const { deps, invoke } = await setup();
    const { instancePaths } = await import('../../../src/fleet/paths.ts');
    const blockedRoot = `${instancePaths('line-a').stateRoot}.mutation`;
    mkdirSync(dirname(blockedRoot), { recursive: true });
    writeFileSync(blockedRoot, 'blocked');
    try {
      const response = await invoke();
      expect(response.res._status).toBe(500);
      expect(spawnMock).not.toHaveBeenCalled();
      expect(deps.serviceManager.stop).not.toHaveBeenCalled();
    } finally { unlinkSync(blockedRoot); }
    await invoke();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it.each(['config', 'delete', 'restart', 'checkpoint'] as const)('refuses %s while a pairing helper owns the instance', async (operation) => {
    const { deps, invoke, configPath } = await setup();
    await invoke();
    vi.mocked(deps.serviceManager.stop).mockClear();
    const res = mockRes();
    const req = mockReq({ method: 'POST', body: '{}' });
    if (operation === 'config') {
      const { handleConfigUpdate } = await import('../../../src/fleet/routes/ops-config.ts');
      await handleConfigUpdate(req, res, deps, { name: 'line-a' });
    } else if (operation === 'checkpoint') {
      const { handleRestoreCheckpoint } = await import('../../../src/fleet/routes/checkpoints.ts');
      await handleRestoreCheckpoint(req, res, deps as never, { name: 'line-a' });
    } else {
      const { handleDeleteLine, handleRestart } = await import('../../../src/fleet/routes/ops-lifecycle.ts');
      await (operation === 'delete' ? handleDeleteLine : handleRestart)(req, res, deps, { name: 'line-a' });
    }
    expect(res._status).toBe(409);
    expect(res._body).toContain('instance_mutation_in_progress');
    expect(readFileSync(configPath, 'utf8')).toBe('{}');
    expect(deps.serviceManager.stop).not.toHaveBeenCalled();
    expect(deps.serviceManager.restart).not.toHaveBeenCalled();
    expect(deps.serviceManager.disable).not.toHaveBeenCalled();
  });

  it('refuses auth while deletion waits for service stop and releases after deletion settles', async () => {
    const { deps, invoke } = await setup();
    const { handleDeleteLine } = await import('../../../src/fleet/routes/ops-lifecycle.ts');
    let finish!: () => void;
    vi.mocked(deps.serviceManager.stop).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const deleting = handleDeleteLine(mockReq(), mockRes(), deps, { name: 'line-a' });
    const blocked = await invoke();
    expect(blocked.res._status).toBe(409);
    expect(spawnMock).not.toHaveBeenCalled();
    finish();
    await deleting;
    await invoke();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('refuses to launch a credential writer when the fallback service stop fails', async () => {
    const { deps, invoke, configPath } = await setup();
    vi.mocked(deps.serviceManager.stop).mockRejectedValueOnce(new Error('stop outcome unknown'));
    const { res } = await invoke();
    expect(res._ended).toBe(true);
    expect(res._chunks.join('')).toContain('Unable to stop');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(deps.serviceManager.startFire).not.toHaveBeenCalled();
    expect(readFileSync(configPath, 'utf8')).toBe('{}');
    await invoke();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('ignores a late connected event after cancellation without resetting persisted configuration', async () => {
    const { deps, invoke, configPath } = await setup();
    const first = await invoke();
    first.req.emit('close');
    const child = children[0]!;
    child.stdout.emit('data', Buffer.from('{"event":"connected"}\n'));
    await vi.advanceTimersByTimeAsync(15_001);
    expect(first.res._chunks.join('')).not.toContain('event: connected');
    expect(deps.discovery.scan).not.toHaveBeenCalled();
    expect(deps.serviceManager.startFire).not.toHaveBeenCalled();
    expect(readFileSync(configPath, 'utf8')).toBe('{}');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends an unconfirmed activation response but retains admission until the callback settles', async () => {
    const { deps, invoke, expectBusy } = await setup();
    let complete!: (error: Error | null) => void;
    vi.mocked(deps.serviceManager.startFire).mockImplementation((_name, callback) => { complete = callback!; });
    const first = await invoke();
    const child = children[0]!;
    child.stdout.emit('data', Buffer.from('{"event":"connected"}\n'));
    child.emit('close', 0);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(first.res._ended).toBe(true);
    expect(first.res._chunks.join('')).toContain('not confirmed');
    expect(first.res._chunks.join('')).not.toContain('event: connected');
    await expectBusy();
    complete(null);
    await Promise.resolve();
    expect(deps.discovery.scan).not.toHaveBeenCalled();
    const next = await invoke();
    expect(next.res._status).toBe(200);
  });
  it.each(['accepted', 'refused', 'throws'])('retains admission after %s termination and recovers only after close', async (signalResult) => {
    const { deps, invoke, expectBusy } = await setup();
    const first = await invoke();
    const child = children[0]!;
    child.kill.mockImplementation(() => {
      if (signalResult === 'throws') throw new Error('signal rejected');
      return signalResult === 'accepted';
    });
    first.req.emit('close');
    await expectBusy();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(10_001);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await expectBusy();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(deps.serviceManager.startFire).not.toHaveBeenCalled();
    child.emit('close', 1);
    await Promise.resolve();
    expect(deps.serviceManager.startFire).toHaveBeenCalledTimes(1);
    const next = await invoke();
    expect(next.res._status).toBe(200);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('does not restart the instance while its timed-out helper can still write credentials', async () => {
    const { deps, invoke, expectBusy } = await setup();
    await invoke();
    const child = children[0]!;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(deps.serviceManager.startFire).not.toHaveBeenCalled();
    await expectBusy();
    child.emit('close', 1);
    await Promise.resolve();
    expect(deps.serviceManager.startFire).toHaveBeenCalledTimes(1);
  });

  it('restores a stopped service and releases admission after synchronous spawn failure', async () => {
    const { deps, invoke } = await setup();
    spawnMock.mockImplementationOnce(() => { throw new Error('spawn rejected'); });
    const failed = await invoke();
    expect(failed.res._ended).toBe(true);
    expect(failed.res._chunks.join('')).toContain('event: error');
    expect(deps.serviceManager.startFire).toHaveBeenCalledTimes(1);
    const next = await invoke();
    expect(next.res._status).toBe(200);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a started child error uncertain until its exit is confirmed', async () => {
    const { deps, invoke, expectBusy } = await setup();
    await invoke();
    const child = children[0]!;
    child.emit('spawn');
    child.emit('error', new Error('signal delivery failed'));
    await expectBusy();
    expect(deps.serviceManager.startFire).not.toHaveBeenCalled();
    child.emit('close', 1);
    await Promise.resolve();
    expect(deps.serviceManager.startFire).toHaveBeenCalledTimes(1);
  });
});
