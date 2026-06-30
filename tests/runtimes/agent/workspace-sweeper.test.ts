import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
// WhatSoupSocketServer is a value import in the SUT but only used as a type; stub it
// so importing the sweeper does not pull in the real socket-server dependency tree.
vi.mock('../../../src/mcp/socket-server.ts', () => ({ WhatSoupSocketServer: class {} }));

import { WorkspaceSweeper, type WorkspaceResource } from '../../../src/runtimes/agent/workspace-sweeper.ts';

const IDLE_MS = 30 * 60 * 1000;

function makeRes(overrides: Partial<WorkspaceResource> = {}): WorkspaceResource {
  return {
    socketPath: '/tmp/sock',
    workspacePath: '/tmp/ws',
    socketServer: null,
    mediaBridge: null,
    lastActivity: 0,
    ...overrides,
  };
}

describe('WorkspaceSweeper', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('start() is a no-op when sandboxPerChat is false', () => {
    const sweeper = new WorkspaceSweeper(false, new Map(), () => false);
    sweeper.start();
    expect(sweeper.timer).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('start() arms a timer and is idempotent; stop() clears it and is idempotent', () => {
    const sweeper = new WorkspaceSweeper(true, new Map(), () => false);
    sweeper.start();
    expect(sweeper.timer).not.toBeNull();
    const first = sweeper.timer;
    sweeper.start();
    expect(sweeper.timer).toBe(first);
    sweeper.stop();
    expect(sweeper.timer).toBeNull();
    sweeper.stop();
    expect(sweeper.timer).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sweep() is a no-op when sandboxPerChat is false', () => {
    const ws = new Map([['k', makeRes()]]);
    const sweeper = new WorkspaceSweeper(false, ws, () => false);
    sweeper.sweep();
    expect(ws.has('k')).toBe(true);
  });

  it('preserves active sessions and refreshes their lastActivity', () => {
    const ws = new Map([['k', makeRes({ lastActivity: 0 })]]);
    const sweeper = new WorkspaceSweeper(true, ws, () => true);
    vi.setSystemTime(IDLE_MS * 2);
    sweeper.sweep();
    expect(ws.has('k')).toBe(true);
    expect(ws.get('k')!.lastActivity).toBe(IDLE_MS * 2);
  });

  it('keeps inactive workspaces that are not yet idle-expired', () => {
    const ws = new Map([['k', makeRes({ lastActivity: 0 })]]);
    const sweeper = new WorkspaceSweeper(true, ws, () => false);
    vi.setSystemTime(IDLE_MS - 1);
    sweeper.sweep();
    expect(ws.has('k')).toBe(true);
  });

  it('evicts idle inactive workspaces, stopping socket server and media bridge', () => {
    const stop = vi.fn();
    const mediaBridge = vi.fn();
    const ws = new Map([['k', makeRes({ lastActivity: 0, socketServer: { stop } as never, mediaBridge: mediaBridge as never })]]);
    const sweeper = new WorkspaceSweeper(true, ws, () => false);
    vi.setSystemTime(IDLE_MS + 1);
    sweeper.sweep();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(mediaBridge).toHaveBeenCalledTimes(1);
    expect(ws.has('k')).toBe(false);
  });

  it('tolerates socket-server and media-bridge stop failures and still evicts', () => {
    const ws = new Map([['k', makeRes({
      lastActivity: 0,
      socketServer: { stop: vi.fn(() => { throw new Error('sock'); }) } as never,
      mediaBridge: vi.fn(() => { throw new Error('bridge'); }) as never,
    })]]);
    const sweeper = new WorkspaceSweeper(true, ws, () => false);
    vi.setSystemTime(IDLE_MS + 1);
    expect(() => sweeper.sweep()).not.toThrow();
    expect(ws.has('k')).toBe(false);
  });

  it('touch() ignores undefined keys, no-ops unknown keys, and refreshes known resources', () => {
    const res = makeRes({ lastActivity: 0 });
    const ws = new Map([['k', res]]);
    const sweeper = new WorkspaceSweeper(true, ws, () => false);
    sweeper.touch(undefined);
    expect(res.lastActivity).toBe(0);
    expect(() => sweeper.touch('missing')).not.toThrow();
    vi.setSystemTime(12345);
    sweeper.touch('k');
    expect(res.lastActivity).toBe(12345);
  });

  it('the periodic timer invokes sweep() on each interval', () => {
    const sweeper = new WorkspaceSweeper(true, new Map(), () => false);
    const sweepSpy = vi.spyOn(sweeper, 'sweep');
    sweeper.start();
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(sweepSpy).toHaveBeenCalledTimes(1);
    sweeper.stop();
  });
});
