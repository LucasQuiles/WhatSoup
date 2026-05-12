/**
 * @vitest-environment jsdom
 *
 * Behavior coverage for use-websocket.tsx — RealtimeProvider + useRealtime.
 *
 * Architecture (from source):
 *  - RealtimeProvider wraps children in RealtimeContext.Provider
 *  - On mount: reads fleet-token meta tag via getFleetToken(); if absent, bails
 *  - Mints a WS ticket via api.getWsTicket() → getFleetWebSocketUrl()
 *  - Opens `new WebSocket(url)`
 *  - onopen  → setConnected(true), resets backoff to RECONNECT_BASE_MS (1000)
 *  - onmessage → parseWsEvent():
 *      'connected'      → no-op
 *      'typing_update'  → queryClient.setQueryData(['typing'], applyTypingUpdate)
 *      invalidation evt → queryClient.invalidateQueries(key) per getInvalidationKeys()
 *  - onclose → setConnected(false), invalidate lines/feed/typing,
 *              schedule reconnect with exponential backoff (max 30 000 ms)
 *  - onerror → ws.close() (which triggers onclose → reconnect)
 *  - Cleanup: cancel pending timer, null onclose then close socket (no reconnect)
 *
 * FakeWebSocket recipe (mirrors PR #562 FakeEventSource):
 *   vi.stubGlobal('WebSocket', FakeWebSocket)
 *   wsRegistry[] captures every created instance
 *   .simulateOpen() / .simulateMessage(data) / .simulateClose() / .simulateError()
 *
 * Source surprises:
 *  1. getFleetToken() is imported from '../../console/src/lib/api', not the DOM
 *     directly — must be mocked via vi.mock on that module.
 *  2. Ticket null-path: when getFleetWebSocketUrl returns null (ticket mint fails),
 *     the hook retries on the SAME exponential backoff curve used for close events.
 *  3. Backoff resets on onopen, not on a successful ticket mint.
 *  4. onclose is nulled before cleanup close() to prevent a reconnect loop on unmount.
 *  5. The 'cancelled' flag guards against async connect() resolving after unmount.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { cleanup, render, screen, act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as apiModule from '../../console/src/lib/api';

// ---------------------------------------------------------------------------
// Module-level mock — hoisted before any dynamic imports of use-websocket
// ---------------------------------------------------------------------------

vi.mock('../../console/src/lib/api', () => ({
  api: {
    getWsTicket: vi.fn(),
  },
  getFleetToken: vi.fn(),
}));

const mockedGetFleetToken = vi.mocked(apiModule.getFleetToken);
const mockedGetWsTicket = vi.mocked(apiModule.api.getWsTicket);

// ---------------------------------------------------------------------------
// FakeWebSocket — drop-in for the global WebSocket during tests
// ---------------------------------------------------------------------------

const wsRegistry: FakeWebSocket[] = [];

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    wsRegistry.push(this);
  }

  send(_data: string): void {}

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason, wasClean: code === 1000 }));
  }

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateMessage(data: string): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  /** Calls hook's onclose without touching readyState guard — mirrors a server-side close. */
  simulateClose(code = 1006, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason, wasClean: false }));
  }

  simulateError(): void {
    this.onerror?.(new Event('error'));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addFleetToken(token = 'test-fleet-token'): void {
  const meta = document.createElement('meta');
  meta.name = 'fleet-token';
  meta.content = token;
  document.head.appendChild(meta);
}

function removeFleetToken(): void {
  document.querySelectorAll('meta[name="fleet-token"]').forEach((el) => el.remove());
}

function buildQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/**
 * Flush the pending useEffect microtask + Promise chain so the WebSocket
 * constructor is called before the test makes assertions. Uses
 * vi.advanceTimersByTimeAsync(0) which pumps microtasks without advancing
 * the clock.
 */
async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Render RealtimeProvider + Consumer, return a connected-state reader. */
async function renderProvider(queryClient: QueryClient): Promise<{ getConnected: () => boolean }> {
  const { RealtimeProvider, useRealtime } = await import('../../console/src/hooks/use-websocket');

  function Consumer() {
    const { connected } = useRealtime();
    return createElement('div', { 'data-testid': 'status' }, connected ? 'connected' : 'disconnected');
  }

  function Tree({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RealtimeProvider, null, children),
    );
  }

  render(createElement(Tree, null, createElement(Consumer, null)));

  return { getConnected: () => screen.getByTestId('status').textContent === 'connected' };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  wsRegistry.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  addFleetToken('root-token');
  mockedGetFleetToken.mockReturnValue('root-token');
  mockedGetWsTicket.mockResolvedValue({ ticket: 'ws-ticket-1', expiresIn: 60 });
});

afterEach(() => {
  cleanup();
  removeFleetToken();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Connect on mount
// ---------------------------------------------------------------------------

describe('RealtimeProvider — mount and connect', () => {
  it('opens a WebSocket to the ticket URL on mount', async () => {
    await renderProvider(buildQueryClient());
    await flush();

    expect(wsRegistry).toHaveLength(1);
    expect(wsRegistry[0].url).toMatch(/^ws:/);
    expect(wsRegistry[0].url).toContain('ticket=ws-ticket-1');
  });

  it('reports disconnected before socket opens', async () => {
    const { getConnected } = await renderProvider(buildQueryClient());
    await flush();

    expect(wsRegistry).toHaveLength(1);
    expect(getConnected()).toBe(false);
  });

  it('reports connected after onopen fires', async () => {
    const { getConnected } = await renderProvider(buildQueryClient());
    await flush();

    act(() => { wsRegistry[0].simulateOpen(); });

    expect(getConnected()).toBe(true);
  });

  it('embeds the ticket value in the WebSocket URL', async () => {
    mockedGetWsTicket.mockResolvedValueOnce({ ticket: 'tkt-abc123', expiresIn: 30 });

    await renderProvider(buildQueryClient());
    await flush();

    expect(wsRegistry[0].url).toContain('ticket=tkt-abc123');
  });
});

// ---------------------------------------------------------------------------
// No fleet token
// ---------------------------------------------------------------------------

describe('RealtimeProvider — no fleet token', () => {
  it('does not open a WebSocket when fleet token is absent', async () => {
    removeFleetToken();
    mockedGetFleetToken.mockReturnValue(null);

    await renderProvider(buildQueryClient());
    await flush();

    expect(wsRegistry).toHaveLength(0);
  });

  it('reports disconnected when fleet token is absent', async () => {
    removeFleetToken();
    mockedGetFleetToken.mockReturnValue(null);

    const { getConnected } = await renderProvider(buildQueryClient());
    await flush();

    expect(getConnected()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ticket mint failure + backoff retry
// ---------------------------------------------------------------------------

describe('RealtimeProvider — ticket mint failure and backoff', () => {
  it('schedules a reconnect after 1000 ms when ticket mint fails', async () => {
    mockedGetWsTicket
      .mockRejectedValueOnce(new Error('unauthenticated'))
      .mockResolvedValue({ ticket: 'ws-ticket-2', expiresIn: 60 });

    await renderProvider(buildQueryClient());
    await flush();

    expect(wsRegistry).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    expect(wsRegistry).toHaveLength(1);
    expect(wsRegistry[0].url).toContain('ticket=ws-ticket-2');
  });

  it('doubles the backoff after a second consecutive failure (1000 ms → 2000 ms)', async () => {
    mockedGetWsTicket
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockRejectedValueOnce(new Error('fail-2'))
      .mockResolvedValue({ ticket: 'ws-ticket-ok', expiresIn: 60 });

    await renderProvider(buildQueryClient());
    await flush();

    // First retry at 1000 ms — also fails
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(wsRegistry).toHaveLength(0);

    // Second retry at 2000 ms — succeeds
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(wsRegistry).toHaveLength(1);
    expect(wsRegistry[0].url).toContain('ticket=ws-ticket-ok');
  });
});

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

describe('RealtimeProvider — message handling', () => {
  it('ignores "connected" frames with no side effects', async () => {
    const qc = buildQueryClient();
    vi.spyOn(qc, 'invalidateQueries');
    vi.spyOn(qc, 'setQueryData');

    await renderProvider(qc);
    await flush();
    act(() => { wsRegistry[0].simulateOpen(); });

    act(() => {
      wsRegistry[0].simulateMessage(JSON.stringify({ type: 'connected', timestamp: Date.now() }));
    });

    expect(qc.invalidateQueries).not.toHaveBeenCalled();
    expect(qc.setQueryData).not.toHaveBeenCalled();
  });

  it('calls setQueryData([typing]) for typing_update events', async () => {
    const qc = buildQueryClient();
    vi.spyOn(qc, 'setQueryData');

    await renderProvider(qc);
    await flush();
    act(() => { wsRegistry[0].simulateOpen(); });

    act(() => {
      wsRegistry[0].simulateMessage(JSON.stringify({
        type: 'typing_update',
        instance: 'alpha',
        jid: '155501234@s.whatsapp.net',
        composing: true,
        since: 1000,
      }));
    });

    expect(qc.setQueryData).toHaveBeenCalledWith(['typing'], expect.any(Function));
  });

  it('invalidates lines and lines/instance on instance_status events', async () => {
    const qc = buildQueryClient();
    vi.spyOn(qc, 'invalidateQueries');

    await renderProvider(qc);
    await flush();
    act(() => { wsRegistry[0].simulateOpen(); });

    act(() => {
      wsRegistry[0].simulateMessage(JSON.stringify({ type: 'instance_status', instance: 'alpha' }));
    });

    const keys = (qc.invalidateQueries as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
    expect(keys).toContainEqual(['lines']);
    expect(keys).toContainEqual(['lines', 'alpha']);
  });

  it('invalidates messages/chats/search on message_received events', async () => {
    const qc = buildQueryClient();
    vi.spyOn(qc, 'invalidateQueries');

    await renderProvider(qc);
    await flush();
    act(() => { wsRegistry[0].simulateOpen(); });

    act(() => {
      wsRegistry[0].simulateMessage(JSON.stringify({ type: 'message_received', instance: 'beta' }));
    });

    const keys = (qc.invalidateQueries as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
    expect(keys).toContainEqual(['messages', 'beta']);
    expect(keys).toContainEqual(['chats', 'beta']);
    expect(keys).toContainEqual(['search', 'beta']);
  });

  it('invalidates feed on feed_event', async () => {
    const qc = buildQueryClient();
    vi.spyOn(qc, 'invalidateQueries');

    await renderProvider(qc);
    await flush();
    act(() => { wsRegistry[0].simulateOpen(); });

    act(() => {
      wsRegistry[0].simulateMessage(JSON.stringify({ type: 'feed_event', instance: 'gamma' }));
    });

    const keys = (qc.invalidateQueries as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
    expect(keys).toContainEqual(['feed']);
  });

  it('silently drops malformed JSON frames without crashing', async () => {
    const qc = buildQueryClient();
    vi.spyOn(qc, 'invalidateQueries');
    vi.spyOn(qc, 'setQueryData');

    await renderProvider(qc);
    await flush();
    act(() => { wsRegistry[0].simulateOpen(); });

    act(() => {
      wsRegistry[0].simulateMessage('not json at all');
      wsRegistry[0].simulateMessage('{"type":"unknown_event","instance":"x"}');
    });

    expect(qc.invalidateQueries).not.toHaveBeenCalled();
    expect(qc.setQueryData).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Disconnect and reconnect
// ---------------------------------------------------------------------------

describe('RealtimeProvider — disconnect and reconnect', () => {
  it('reports disconnected after socket closes', async () => {
    const { getConnected } = await renderProvider(buildQueryClient());
    await flush();

    act(() => { wsRegistry[0].simulateOpen(); });
    expect(getConnected()).toBe(true);

    act(() => { wsRegistry[0].simulateClose(); });
    expect(getConnected()).toBe(false);
  });

  it('invalidates lines/feed/typing queries on disconnect', async () => {
    const qc = buildQueryClient();
    vi.spyOn(qc, 'invalidateQueries');

    await renderProvider(qc);
    await flush();
    act(() => { wsRegistry[0].simulateOpen(); });

    (qc.invalidateQueries as ReturnType<typeof vi.spyOn>).mockClear();
    act(() => { wsRegistry[0].simulateClose(); });

    const keys = (qc.invalidateQueries as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
    expect(keys).toContainEqual(['lines']);
    expect(keys).toContainEqual(['feed']);
    expect(keys).toContainEqual(['typing']);
  });

  it('automatically reconnects after socket closes', async () => {
    mockedGetWsTicket
      .mockResolvedValueOnce({ ticket: 'tkt-1', expiresIn: 60 })
      .mockResolvedValueOnce({ ticket: 'tkt-2', expiresIn: 60 });

    await renderProvider(buildQueryClient());
    await flush();

    act(() => { wsRegistry[0].simulateOpen(); });
    act(() => { wsRegistry[0].simulateClose(); });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    expect(wsRegistry).toHaveLength(2);
    expect(wsRegistry[1].url).toContain('ticket=tkt-2');
  });

  it('resets backoff to 1000 ms after a successful open, so next close retries quickly', async () => {
    mockedGetWsTicket
      .mockResolvedValueOnce({ ticket: 'tkt-1', expiresIn: 60 })
      .mockResolvedValueOnce({ ticket: 'tkt-2', expiresIn: 60 })
      .mockResolvedValueOnce({ ticket: 'tkt-3', expiresIn: 60 });

    await renderProvider(buildQueryClient());
    await flush();

    // First connect + disconnect
    act(() => { wsRegistry[0].simulateOpen(); });
    act(() => { wsRegistry[0].simulateClose(); });

    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(wsRegistry).toHaveLength(2);

    // Second open resets backoff; second disconnect should retry in another 1000 ms
    act(() => { wsRegistry[1].simulateOpen(); });
    act(() => { wsRegistry[1].simulateClose(); });

    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(wsRegistry).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('RealtimeProvider — error handling', () => {
  it('onerror closes the socket, transitioning to disconnected', async () => {
    const { getConnected } = await renderProvider(buildQueryClient());
    await flush();

    act(() => { wsRegistry[0].simulateOpen(); });
    expect(getConnected()).toBe(true);

    // onerror → ws.close() → onclose fires → setConnected(false)
    act(() => { wsRegistry[0].simulateError(); });

    expect(getConnected()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cleanup on unmount
// ---------------------------------------------------------------------------

describe('RealtimeProvider — cleanup on unmount', () => {
  it('cancels the pending reconnect timer so no second socket is opened after unmount', async () => {
    mockedGetWsTicket
      .mockResolvedValueOnce({ ticket: 'tkt-1', expiresIn: 60 })
      .mockResolvedValue({ ticket: 'tkt-2', expiresIn: 60 });

    const { RealtimeProvider } = await import('../../console/src/hooks/use-websocket');
    const qc = buildQueryClient();

    const { unmount } = render(
      createElement(QueryClientProvider, { client: qc },
        createElement(RealtimeProvider, null, createElement('div', null, 'child')),
      ),
    );

    await flush();
    act(() => { wsRegistry[0].simulateOpen(); });
    act(() => { wsRegistry[0].simulateClose(); });

    // Unmount before the 1000 ms reconnect fires
    unmount();

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    // No second socket — reconnect was cancelled
    expect(wsRegistry).toHaveLength(1);
  });

  it('closes the open socket on unmount and does not open a second one', async () => {
    mockedGetWsTicket.mockResolvedValue({ ticket: 'tkt-1', expiresIn: 60 });

    const { RealtimeProvider } = await import('../../console/src/hooks/use-websocket');
    const qc = buildQueryClient();

    const { unmount } = render(
      createElement(QueryClientProvider, { client: qc },
        createElement(RealtimeProvider, null, createElement('div', null, 'child')),
      ),
    );

    await flush();
    act(() => { wsRegistry[0].simulateOpen(); });

    unmount();

    expect(wsRegistry[0].readyState).toBe(FakeWebSocket.CLOSED);

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(wsRegistry).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// useRealtime hook
// ---------------------------------------------------------------------------

describe('useRealtime hook', () => {
  it('returns connected: false when called outside a provider (uses default context)', async () => {
    const { useRealtime } = await import('../../console/src/hooks/use-websocket');
    const { result } = renderHook(() => useRealtime());
    expect(result.current.connected).toBe(false);
  });

  it('returns connected: true while the provider socket is open', async () => {
    const { getConnected } = await renderProvider(buildQueryClient());
    await flush();

    act(() => { wsRegistry[0].simulateOpen(); });

    expect(getConnected()).toBe(true);
  });
});
