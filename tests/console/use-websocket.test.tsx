/**
 * @vitest-environment jsdom
 *
 * Behavior coverage for use-websocket.tsx — RealtimeProvider + useRealtime.
 *
 * Architecture (from source):
 *  - RealtimeProvider wraps children in RealtimeContext.Provider
 *  - On mount: checks production mode via isProductionConsole(); if dev, bails
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
 *  1. isProductionConsole() is imported from '../../console/src/lib/api', not the DOM
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
  isProductionConsole: vi.fn(),
}));

const mockedIsProduction = vi.mocked(apiModule.isProductionConsole);
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

function addProductionAuthMode(): void {
  const meta = document.createElement('meta');
  meta.name = 'fleet-auth-mode';
  meta.content = 'session';
  document.head.appendChild(meta);
}

function removeFleetToken(): void {
  document.querySelectorAll('meta[name="fleet-auth-mode"]').forEach((el) => el.remove());
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
  addProductionAuthMode();
  mockedIsProduction.mockReturnValue(true);
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
    mockedIsProduction.mockReturnValue(false);

    await renderProvider(buildQueryClient());
    await flush();

    expect(wsRegistry).toHaveLength(0);
  });

  it('reports disconnected when fleet token is absent', async () => {
    removeFleetToken();
    mockedIsProduction.mockReturnValue(false);

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

  it('caps backoff at RECONNECT_MAX_MS=30_000 after repeated failures', async () => {
    // Backoff curve: 1000→2000→4000→8000→16000→30000(capped)→30000(still capped)
    // The cap means the 6th retry fires at 30_000ms delay, not 32_000ms (2^5 * 1000).
    // We prove the cap by:
    //   - advancing through 5 failures using per-step increments
    //   - at the 6th retry window, asserting no socket before 30000ms but one after
    mockedGetWsTicket
      .mockRejectedValueOnce(new Error('fail-1'))  // schedules retry at delay=1000
      .mockRejectedValueOnce(new Error('fail-2'))  // schedules retry at delay=2000
      .mockRejectedValueOnce(new Error('fail-3'))  // schedules retry at delay=4000
      .mockRejectedValueOnce(new Error('fail-4'))  // schedules retry at delay=8000
      .mockRejectedValueOnce(new Error('fail-5'))  // schedules retry at delay=16000
      .mockRejectedValueOnce(new Error('fail-6'))  // schedules retry at delay=30000 (capped, not 32000)
      .mockResolvedValue({ ticket: 'ws-ticket-cap', expiresIn: 60 });

    await renderProvider(buildQueryClient());
    await flush();

    // Drain failures 1–5 using their individual timer windows.
    // Each advance fires the current pending retry; the mock then rejects again.
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });   // fires retry 1
    expect(wsRegistry).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });   // fires retry 2
    expect(wsRegistry).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(4100); });   // fires retry 3
    expect(wsRegistry).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(8100); });   // fires retry 4
    expect(wsRegistry).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(16100); });  // fires retry 5
    expect(wsRegistry).toHaveLength(0);

    // Retry 6 is scheduled at delay=30_000 (the cap). Advance 29_000ms — socket must NOT exist yet.
    await act(async () => { await vi.advanceTimersByTimeAsync(29_000); });
    expect(wsRegistry).toHaveLength(0);

    // Advance the remaining ~1100ms to cross the 30_000ms cap threshold — socket now opens.
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(wsRegistry).toHaveLength(1);
    expect(wsRegistry[0].url).toContain('ticket=ws-ticket-cap');
  });

  it('resets backoff to 1000ms after successful open following an elevated retry delay', async () => {
    // Step 1: fail the ticket once → delay escalates to 2000ms
    // Step 2: succeed ticket → open socket → onopen resets backoff to 1000ms
    // Step 3: close socket → next reconnect must fire at ~1100ms, not ~2100ms
    mockedGetWsTicket
      .mockRejectedValueOnce(new Error('fail-1'))              // drives delay to 2000ms
      .mockResolvedValueOnce({ ticket: 'tkt-open', expiresIn: 60 })  // fires at 1000ms
      .mockResolvedValueOnce({ ticket: 'tkt-after-reset', expiresIn: 60 }); // after close

    await renderProvider(buildQueryClient());
    await flush();

    // Consume the first failure; the retry is scheduled at 1000ms.
    expect(wsRegistry).toHaveLength(0);

    // Advance 1100ms — second attempt succeeds, socket is created.
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(wsRegistry).toHaveLength(1);

    // Open the socket — this triggers onopen which resets reconnectDelay to 1000ms.
    act(() => { wsRegistry[0].simulateOpen(); });

    // Close the socket — onclose schedules reconnect at the (now-reset) 1000ms delay.
    act(() => { wsRegistry[0].simulateClose(); });

    // At 1100ms the reconnect should already have fired (reset to 1000ms, not 2000ms).
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(wsRegistry).toHaveLength(2);
    expect(wsRegistry[1].url).toContain('ticket=tkt-after-reset');

    // Confirm it did NOT fire at the un-reset 2000ms interval — if backoff were still
    // 2000ms, the second socket would not exist yet at the 1100ms mark above.
    // The assertion wsRegistry.toHaveLength(2) above is the definitive proof.
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

  it('invalidates lines, lines/instance, and provider-status on instance_status events', async () => {
    const qc = buildQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    await renderProvider(qc);
    await flush();
    act(() => { wsRegistry[0].simulateOpen(); });

    act(() => {
      wsRegistry[0].simulateMessage(JSON.stringify({ type: 'instance_status', instance: 'alpha' }));
    });

    const keys = invalidateSpy.mock.calls
      .map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
    expect(keys).toContainEqual(['lines']);
    expect(keys).toContainEqual(['lines', 'alpha']);
    expect(keys).toContainEqual(['provider-status', 'alpha']);
  });

  it('invalidates messages/chats/search on message_received events', async () => {
    const qc = buildQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    await renderProvider(qc);
    await flush();
    act(() => { wsRegistry[0].simulateOpen(); });

    act(() => {
      wsRegistry[0].simulateMessage(JSON.stringify({ type: 'message_received', instance: 'beta' }));
    });

    const keys = invalidateSpy.mock.calls
      .map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
    expect(keys).toContainEqual(['messages', 'beta']);
    expect(keys).toContainEqual(['chats', 'beta']);
    expect(keys).toContainEqual(['search', 'beta']);
  });

  it('invalidates feed on feed_event', async () => {
    const qc = buildQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    await renderProvider(qc);
    await flush();
    act(() => { wsRegistry[0].simulateOpen(); });

    act(() => {
      wsRegistry[0].simulateMessage(JSON.stringify({ type: 'feed_event', instance: 'gamma' }));
    });

    const keys = invalidateSpy.mock.calls
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
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    await renderProvider(qc);
    await flush();
    act(() => { wsRegistry[0].simulateOpen(); });

    invalidateSpy.mockClear();
    act(() => { wsRegistry[0].simulateClose(); });

    const keys = invalidateSpy.mock.calls
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

// ---------------------------------------------------------------------------
// Stream gap reconciliation (#2519)
// ---------------------------------------------------------------------------

describe('RealtimeProvider — stream gap reconciliation', () => {
  function hello(generation: string, sequence: number): string {
    return JSON.stringify({
      type: 'connected',
      timestamp: 1_723_800_000_000,
      schema_version: 1,
      stream_generation: generation,
      sequence,
    });
  }

  it('a reconnect onto a new generation invalidates every realtime-owned family', async () => {
    const qc = buildQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    await renderProvider(qc);
    await flush();
    act(() => {
      wsRegistry[0].simulateOpen();
      wsRegistry[0].simulateMessage(hello('gen-a', 4));
    });
    act(() => {
      wsRegistry[0].simulateClose();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    invalidateSpy.mockClear();
    act(() => {
      wsRegistry[1].simulateOpen();
      wsRegistry[1].simulateMessage(hello('gen-b', 0));
    });
    const keys = invalidateSpy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys, 'the #2519 falsifier: a gapped reconnect must reconcile logs').toContain('["logs"]');
    expect(keys).toContain('["chats"]');
    expect(keys).toContain('["access"]');
    expect(keys).toContain('["messages"]');
  });

  it('a reconnect onto the same generation and sequence stays quiet', async () => {
    const qc = buildQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    await renderProvider(qc);
    await flush();
    act(() => {
      wsRegistry[0].simulateOpen();
      wsRegistry[0].simulateMessage(hello('gen-a', 4));
    });
    act(() => {
      wsRegistry[0].simulateClose();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    invalidateSpy.mockClear();
    act(() => {
      wsRegistry[1].simulateOpen();
      wsRegistry[1].simulateMessage(hello('gen-a', 4));
    });
    const keys = invalidateSpy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys, 'nothing was missed: proven-current reconnect must not storm refetches').not.toContain('["logs"]');
  });

  it('an unverifiable hello after a verified session reconciles', async () => {
    const qc = buildQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    await renderProvider(qc);
    await flush();
    act(() => {
      wsRegistry[0].simulateOpen();
      wsRegistry[0].simulateMessage(hello('gen-a', 4));
    });
    act(() => {
      wsRegistry[0].simulateClose();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    invalidateSpy.mockClear();
    act(() => {
      wsRegistry[1].simulateOpen();
      wsRegistry[1].simulateMessage(JSON.stringify({ type: 'connected', timestamp: 1 }));
    });
    const keys = invalidateSpy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys, 'an envelope-less hello proves nothing: fail toward reconciliation').toContain('["logs"]');
  });

  it('a non-contiguous frame sequence forces reconciliation mid-stream', async () => {
    const qc = buildQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    await renderProvider(qc);
    await flush();
    act(() => {
      wsRegistry[0].simulateOpen();
      wsRegistry[0].simulateMessage(hello('gen-a', 4));
      wsRegistry[0].simulateMessage(JSON.stringify({
        type: 'feed_event',
        instance: 'synthetic-a',
        schema_version: 1,
        stream_generation: 'gen-a',
        sequence: 5,
      }));
    });
    invalidateSpy.mockClear();
    act(() => {
      wsRegistry[0].simulateMessage(JSON.stringify({
        type: 'feed_event',
        instance: 'synthetic-a',
        schema_version: 1,
        stream_generation: 'gen-a',
        sequence: 9,
      }));
    });
    const keys = invalidateSpy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys, 'frames 6-8 were lost: every realtime family must reconcile').toContain('["logs"]');
    expect(keys).toContain('["chats"]');
  });
});
