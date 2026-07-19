/**
 * useLines freshness wiring (D-3/F-UX-4): the lines query plane must carry
 * the same fail-closed {observedAt, stale} contract the metrics planes got
 * in #1925 — with a poll-aware threshold (2 × the active poll interval:
 * POLL_LINES_WS_BACKSTOP when the WS is connected, POLL_LINES otherwise).
 *
 * Clock control: `vi.spyOn(Date, 'now')` (NOT full fake timers) so
 * react-query's real-timer machinery keeps working while the freshness
 * clock is deterministic. `rerender()` recomputes freshness (computed in
 * the hook body) against the advanced clock.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const useRealtimeMock = vi.hoisted(() => vi.fn());
const getLinesMock = vi.hoisted(() => vi.fn());

vi.mock('../../console/src/hooks/use-websocket', () => ({
  useRealtime: useRealtimeMock,
}));

vi.mock('../../console/src/lib/api', () => ({
  api: { getLines: getLinesMock },
}));

import { useLines } from '../../console/src/hooks/use-fleet';

const T0 = 1_800_000_000_000;
let nowSpy: ReturnType<typeof vi.spyOn>;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  getLinesMock.mockResolvedValue([]);
  nowSpy = vi.spyOn(Date, 'now').mockReturnValue(T0);
});

afterEach(() => {
  cleanup();
  nowSpy.mockRestore();
  vi.clearAllMocks();
});

describe('useLines freshness (query-plane freshness contract)', () => {
  it('exposes freshness with observedAt from the query and stale=false when current (WS connected)', async () => {
    useRealtimeMock.mockReturnValue({ connected: true });
    const { result } = renderHook(() => useLines(), { wrapper });
    await waitFor(() => expect(result.current.freshness?.observedAt).toBe(T0));
    expect(result.current.freshness?.stale).toBe(false);
  });

  it('WS-connected plane (15s backstop poll) is NOT stale 12s after the last fetch (threshold 2×15s)', async () => {
    useRealtimeMock.mockReturnValue({ connected: true });
    const { result, rerender } = renderHook(() => useLines(), { wrapper });
    await waitFor(() => expect(result.current.freshness?.observedAt).toBe(T0));
    nowSpy.mockReturnValue(T0 + 12_000);
    rerender();
    expect(result.current.freshness?.stale).toBe(false);
  });

  it('disconnected plane (5s poll) IS stale 12s after the last fetch (threshold 2×5s)', async () => {
    useRealtimeMock.mockReturnValue({ connected: false });
    const { result, rerender } = renderHook(() => useLines(), { wrapper });
    await waitFor(() => expect(result.current.freshness?.observedAt).toBe(T0));
    nowSpy.mockReturnValue(T0 + 12_000);
    rerender();
    expect(result.current.freshness?.stale).toBe(true);
  });
});
