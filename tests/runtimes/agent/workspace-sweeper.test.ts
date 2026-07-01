import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('../../../src/mcp/socket-server.ts', () => ({
  WhatSoupSocketServer: class {},
}));

import { WorkspaceSweeper, type WorkspaceResource } from '../../../src/runtimes/agent/workspace-sweeper.ts';

const IDLE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

function makeWorkspace(overrides: Partial<WorkspaceResource> = {}): WorkspaceResource {
  return {
    socketPath: '/tmp/whatsoup.sock',
    workspacePath: '/tmp/whatsoup-workspace',
    socketServer: null,
    mediaBridge: null,
    lastActivity: 0,
    ...overrides,
  };
}

describe('WorkspaceSweeper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not arm or sweep when per-chat sandboxes are disabled', () => {
    const workspaces = new Map([['chat-1', makeWorkspace()]]);
    const sweeper = new WorkspaceSweeper(false, workspaces, () => false);

    sweeper.start();
    sweeper.sweep();

    expect(sweeper.timer).toBeNull();
    expect(workspaces.has('chat-1')).toBe(true);
  });

  it('arms one periodic sweep timer and clears it idempotently', () => {
    const sweeper = new WorkspaceSweeper(true, new Map(), () => false);
    const sweepSpy = vi.spyOn(sweeper, 'sweep');

    sweeper.start();
    const firstTimer = sweeper.timer;
    sweeper.start();

    expect(firstTimer).not.toBeNull();
    expect(sweeper.timer).toBe(firstTimer);

    sweeper.stop();
    sweeper.stop();

    expect(sweeper.timer).toBeNull();
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
    expect(sweepSpy).toHaveBeenCalledTimes(0);
  });

  it('invokes sweep on each periodic timer interval', () => {
    const sweeper = new WorkspaceSweeper(true, new Map(), () => false);
    const sweepSpy = vi.spyOn(sweeper, 'sweep');

    sweeper.start();
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);

    expect(sweepSpy).toHaveBeenCalledTimes(1);
    sweeper.stop();
  });

  it('keeps active sessions and refreshes their activity timestamp', () => {
    const workspaces = new Map([['chat-1', makeWorkspace({ lastActivity: 0 })]]);
    const sweeper = new WorkspaceSweeper(true, workspaces, () => true);

    vi.setSystemTime(IDLE_MS * 2);
    sweeper.sweep();

    expect(workspaces.has('chat-1')).toBe(true);
    expect(workspaces.get('chat-1')?.lastActivity).toBe(IDLE_MS * 2);
  });

  it('keeps inactive workspaces until they exceed the idle threshold', () => {
    const workspaces = new Map([['chat-1', makeWorkspace({ lastActivity: 0 })]]);
    const sweeper = new WorkspaceSweeper(true, workspaces, () => false);

    vi.setSystemTime(IDLE_MS);
    sweeper.sweep();

    expect(workspaces.has('chat-1')).toBe(true);
  });

  it('evicts idle inactive workspaces after stopping socket and media resources', () => {
    const stopSocketServer = vi.fn();
    const stopMediaBridge = vi.fn();
    const workspaces = new Map([
      [
        'chat-1',
        makeWorkspace({
          lastActivity: 0,
          socketServer: { stop: stopSocketServer } as never,
          mediaBridge: stopMediaBridge as never,
        }),
      ],
    ]);
    const sweeper = new WorkspaceSweeper(true, workspaces, () => false);

    vi.setSystemTime(IDLE_MS + 1);
    sweeper.sweep();

    expect(stopSocketServer).toHaveBeenCalledTimes(1);
    expect(stopMediaBridge).toHaveBeenCalledTimes(1);
    expect(workspaces.has('chat-1')).toBe(false);
  });

  it('evicts idle inactive workspaces when optional resources are already absent', () => {
    const workspaces = new Map([
      ['chat-1', makeWorkspace({ lastActivity: 0 })],
    ]);
    const sweeper = new WorkspaceSweeper(true, workspaces, () => false);

    vi.setSystemTime(IDLE_MS + 1);
    sweeper.sweep();

    expect(workspaces.size).toBe(0);
  });

  it('still evicts idle workspaces when resource cleanup throws', () => {
    const workspaces = new Map([
      [
        'chat-1',
        makeWorkspace({
          lastActivity: 0,
          socketServer: {
            stop: vi.fn(() => {
              throw new Error('socket stop failed');
            }),
          } as never,
          mediaBridge: vi.fn(() => {
            throw new Error('media bridge stop failed');
          }) as never,
        }),
      ],
    ]);
    const sweeper = new WorkspaceSweeper(true, workspaces, () => false);

    vi.setSystemTime(IDLE_MS + 1);

    expect(() => sweeper.sweep()).not.toThrow();
    expect(workspaces.has('chat-1')).toBe(false);
  });

  it('touch ignores missing keys and refreshes known workspace activity', () => {
    const resource = makeWorkspace({ lastActivity: 0 });
    const workspaces = new Map([['chat-1', resource]]);
    const sweeper = new WorkspaceSweeper(true, workspaces, () => false);

    sweeper.touch(undefined);
    sweeper.touch('missing');
    vi.setSystemTime(12_345);
    sweeper.touch('chat-1');

    expect(resource.lastActivity).toBe(12_345);
  });
});
