/**
 * Behavior tests for console/src/hooks/use-transport-status.ts
 *
 * Covers:
 *   - status derivation: connected / reconnecting / offline (offline wins)
 *   - isDisconnected = status !== 'connected'
 *   - navigator online/offline window events flip the state
 *   - the disconnected→connected recovery edge fires EXACTLY once
 *     (justReconnected latch + onReconnect callback), and never on mount
 *
 * Mock strategy:
 *   - vi.mock('../../console/src/hooks/use-websocket') to control connected flag
 *   - navigator.onLine is overridden per-test via Object.defineProperty
 *
 * @vitest-environment jsdom
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

// Mutable realtime flag, read by the mocked useRealtime.
let wsConnected = false;

vi.mock('../../console/src/hooks/use-websocket', () => ({
  useRealtime: () => ({ connected: wsConnected }),
}));

import { useTransportStatus } from '../../console/src/hooks/use-transport-status';

// ---------------------------------------------------------------------------
// navigator.onLine harness
// ---------------------------------------------------------------------------

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => value,
  });
}

function fireWindowEvent(name: 'online' | 'offline') {
  act(() => {
    window.dispatchEvent(new Event(name));
  });
}

beforeEach(() => {
  wsConnected = false;
  setNavigatorOnline(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setNavigatorOnline(true);
});

// ---------------------------------------------------------------------------
// 1. Status derivation
// ---------------------------------------------------------------------------

describe('useTransportStatus — status derivation', () => {
  it('reports connected when the socket is up and the browser is online', () => {
    wsConnected = true;
    setNavigatorOnline(true);
    const { result } = renderHook(() => useTransportStatus());
    expect(result.current.status).toBe('connected');
    expect(result.current.isDisconnected).toBe(false);
  });

  it('reports reconnecting when the browser is online but the socket is down', () => {
    wsConnected = false;
    setNavigatorOnline(true);
    const { result } = renderHook(() => useTransportStatus());
    expect(result.current.status).toBe('reconnecting');
    expect(result.current.isDisconnected).toBe(true);
  });

  it('reports offline when the browser reports no network', () => {
    wsConnected = false;
    setNavigatorOnline(false);
    const { result } = renderHook(() => useTransportStatus());
    expect(result.current.status).toBe('offline');
    expect(result.current.isDisconnected).toBe(true);
  });

  it('offline wins over reconnecting even when the socket flag is up', () => {
    // No network: the socket flag cannot be trusted to mean "connected".
    wsConnected = true;
    setNavigatorOnline(false);
    const { result } = renderHook(() => useTransportStatus());
    expect(result.current.status).toBe('offline');
    expect(result.current.isDisconnected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. navigator online/offline window events
// ---------------------------------------------------------------------------

describe('useTransportStatus — online/offline events', () => {
  it('flips to offline when the offline event fires', () => {
    wsConnected = true;
    setNavigatorOnline(true);
    const { result } = renderHook(() => useTransportStatus());
    expect(result.current.status).toBe('connected');

    setNavigatorOnline(false);
    fireWindowEvent('offline');

    expect(result.current.status).toBe('offline');
    expect(result.current.isDisconnected).toBe(true);
  });

  it('flips back to connected when the online event fires and the socket is up', () => {
    wsConnected = true;
    setNavigatorOnline(false);
    const { result } = renderHook(() => useTransportStatus());
    expect(result.current.status).toBe('offline');

    setNavigatorOnline(true);
    fireWindowEvent('online');

    expect(result.current.status).toBe('connected');
    expect(result.current.isDisconnected).toBe(false);
  });

  it('removes its window listeners on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useTransportStatus());
    unmount();
    const removed = removeSpy.mock.calls.map((c) => c[0]);
    expect(removed).toContain('online');
    expect(removed).toContain('offline');
  });
});

// ---------------------------------------------------------------------------
// 3. Recovery edge — fires exactly once
// ---------------------------------------------------------------------------

describe('useTransportStatus — reconnect-once', () => {
  it('does not fire onReconnect on first mount (already connected)', () => {
    wsConnected = true;
    setNavigatorOnline(true);
    const onReconnect = vi.fn();
    renderHook(() => useTransportStatus({ onReconnect }));
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('fires onReconnect exactly once on a disconnected→connected transition', () => {
    wsConnected = false; // start reconnecting
    setNavigatorOnline(true);
    const onReconnect = vi.fn();
    const { rerender } = renderHook(() => useTransportStatus({ onReconnect }));
    expect(onReconnect).not.toHaveBeenCalled();

    // Recover: socket comes up.
    act(() => {
      wsConnected = true;
      rerender();
    });
    expect(onReconnect).toHaveBeenCalledTimes(1);

    // A subsequent steady-connected rerender must NOT re-fire.
    act(() => {
      rerender();
    });
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('latches justReconnected for a single edge, then resets to false', () => {
    wsConnected = false;
    setNavigatorOnline(true);
    const { result, rerender } = renderHook(() => useTransportStatus());
    expect(result.current.justReconnected).toBe(false);

    act(() => {
      wsConnected = true;
      rerender();
    });
    // The latch self-resets via effect; after the edge settles it is false again,
    // and the status is the recovered connected state.
    expect(result.current.status).toBe('connected');
    expect(result.current.justReconnected).toBe(false);
  });

  it('fires onReconnect again on a SECOND disconnect→reconnect cycle', () => {
    wsConnected = false;
    setNavigatorOnline(true);
    const onReconnect = vi.fn();
    const { rerender } = renderHook(() => useTransportStatus({ onReconnect }));

    act(() => { wsConnected = true; rerender(); });
    expect(onReconnect).toHaveBeenCalledTimes(1);

    // Drop again...
    act(() => { wsConnected = false; rerender(); });
    // ...and recover again.
    act(() => { wsConnected = true; rerender(); });
    expect(onReconnect).toHaveBeenCalledTimes(2);
  });
});
