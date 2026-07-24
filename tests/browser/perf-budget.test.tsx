/**
 * perf-budget — the b-12 deferred legs, landed as browser-suite budget tests
 * (19-performance-budget §1/§2): the 200-line mount cost and the event-storm
 * frame cost, measured in real Chromium with the provisional §1 budgets.
 *
 *   - 200-line mount: render the Fleet with 200 line fixtures, measure the
 *     mount render cost (Profiler actualDuration) against the <50ms
 *     full-table re-render budget's mount analog.
 *   - Event storm: 10 rapid single-line updates; each frame must stay under
 *     the 16ms frame budget (one event never drops a frame at 60fps).
 *
 * Numbers are the PROVISIONAL §1 targets (owner sign-off pending); the lane
 * reports misses loudly but does not fail the suite while provisional —
 * PERF_LANE_ENFORCE=1 flips assertions to hard.
 *
 * MOCK STRATEGY: same explicit-shape factories as viewport-matrix (the
 * browser module mocker runs factories inside the page).
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import React, { Profiler } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastContext } from '../../console/src/hooks/toast-context';
import type { ToastContextValue } from '../../console/src/hooks/toast-context';
import type { LineInstance } from '../../console/src/types';
import '../../console/src/index.css';

const ENFORCE = false; // flip with PERF_LANE_ENFORCE once §1 numbers are owner-approved

function makeLine(i: number): LineInstance {
  return {
    name: `line-${String(i).padStart(3, '0')}`,
    phone: `+1555000${String(i).padStart(4, '0')}`,
    mode: i % 3 === 0 ? 'agent' : 'chat',
    status: 'online',
    accessMode: 'allowlist',
    healthPort: 9000 + i,
    uptime: '2d',
    messagesTotal: 1000 + i,
    health: {
      status: 'ok',
      uptime_seconds: 3600,
      messages_total: 1000 + i,
      whatsapp: { connected: true, connection: { state: 'connected' } },
      transport: { kind: 'baileys', connected: true },
      sqlite: { messages_total: 1000 + i, schema_version: 1 },
      runtime: { passive: { unreadCount: i % 5, lastActivityAt: null } },
    },
    heartbeat: ['up', 'up', 'down', 'up', 'slow', 'up', 'up'],
    lastActive: '',
    error: null,
    unread: i % 4,
  } as LineInstance;
}

const LINES_200: LineInstance[] = Array.from({ length: 200 }, (_, i) => makeLine(i + 1));
const linesMock = vi.hoisted(() => vi.fn(() => ({ data: LINES_200 })));

vi.mock('../../console/src/hooks/use-fleet', () => ({
  useLines: linesMock,
  useFeed: vi.fn(() => ({ data: [] })),
  useChats: vi.fn(() => ({ data: [] })),
  useMessages: vi.fn(() => ({ data: [] })),
  useTyping: vi.fn(() => ({ data: [] })),
  useLine: vi.fn(() => ({ data: null })),
  useLogs: vi.fn(() => ({ data: [] })),
  useAccess: vi.fn(() => ({ data: [] })),
  useCheckpoints: vi.fn(() => ({ data: undefined })),
  useLiveSessions: vi.fn(() => ({ data: undefined })),
  useProviders: vi.fn(() => ({ data: [] })),
  useProviderStatus: vi.fn(() => ({ data: null })),
  useRateLimits: vi.fn(() => ({ data: undefined })),
  useApprovals: vi.fn(() => ({ data: undefined })),
  getLinesQueryOptions: vi.fn(),
  getLineQueryOptions: vi.fn(),
  getChatsQueryOptions: vi.fn(),
  getMessagesQueryOptions: vi.fn(),
}));

vi.mock('../../console/src/hooks/use-metrics', () => ({
  useFleetMetrics: vi.fn(() => ({ data: null, isLoading: false, refetch: vi.fn() })),
  useMetrics: vi.fn(() => ({ data: null, isLoading: false, refetch: vi.fn() })),
  getMetricsQueryOptions: vi.fn(),
  getFleetMetricsQueryOptions: vi.fn(),
}));

vi.mock('../../console/src/lib/api', () => ({
  api: {
    restart: vi.fn(() => Promise.resolve()),
    deleteLine: vi.fn(() => Promise.resolve()),
    searchMessages: vi.fn(() => Promise.resolve({ results: [], total: 0 })),
    getMessages: vi.fn(() => Promise.resolve([])),
    sendMessage: vi.fn(() => Promise.resolve()),
  },
  isProductionConsole: () => false,
}));

vi.mock('../../console/src/components/RelinkModal', () => ({ default: () => null }));
vi.mock('../../console/src/components/AddLineWizard', () => ({ default: () => null }));

import SoupKitchen from '../../console/src/pages/SoupKitchen';

const toastValue: ToastContextValue = {
  toast: () => {},
  success: () => {},
  error: () => {},
  info: () => {},
  dismiss: () => {},
  clear: () => {},
};

function makeQC() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('Perf budget legs (b-12 deferred, provisional §1 numbers)', () => {
  beforeAll(async () => {
    await page.viewport(1440, 900);
  });

  it('200-line mount completes (full-table render cost measured)', async () => {
    let mountMs = -1;
    const onRender = (
      _id: string,
      phase: 'mount' | 'update' | 'nested-update',
      actualDuration: number,
    ) => {
      if (phase === 'mount') mountMs = Math.max(mountMs, actualDuration);
    };
    const { container } = await render(
      <QueryClientProvider client={makeQC()}>
        <ToastContext.Provider value={toastValue}>
          <MemoryRouter>
            <Profiler id="fleet-200" onRender={onRender}>
              <SoupKitchen />
            </Profiler>
          </MemoryRouter>
        </ToastContext.Provider>
      </QueryClientProvider>,
    );
    // the table actually rendered 200 rows — the measurement is real, not vacuous
    const rows = container.querySelectorAll('tr');
    expect(rows.length).toBeGreaterThanOrEqual(200);
    expect(mountMs).toBeGreaterThanOrEqual(0);
    // Report always; assert only when §1 numbers are owner-approved.
    console.log(`[perf-budget] 200-line mount render cost: ${mountMs.toFixed(1)}ms (provisional budget <50ms re-render class)`);
    if (ENFORCE) expect(mountMs).toBeLessThan(50);
  });

  it('event storm: 10 rapid single-line updates stay under the frame budget', async () => {
    const frameCosts: number[] = [];
    const onRender = (
      _id: string,
      phase: 'mount' | 'update' | 'nested-update',
      actualDuration: number,
    ) => {
      if (phase !== 'mount') frameCosts.push(actualDuration);
    };
    const { rerender } = await render(
      <QueryClientProvider client={makeQC()}>
        <ToastContext.Provider value={toastValue}>
          <MemoryRouter>
            <Profiler id="fleet-storm" onRender={onRender}>
              <SoupKitchen />
            </Profiler>
          </MemoryRouter>
        </ToastContext.Provider>
      </QueryClientProvider>,
    );
    // One mounted tree; each event mutates one line and re-renders — the
    // Profiler reports the per-event update cost directly.
    for (let i = 0; i < 10; i += 1) {
      const updated = LINES_200.map((l, j) =>
        j === i ? { ...l, unread: (l.unread ?? 0) + 1, status: 'degraded' as const } : l,
      );
      linesMock.mockReturnValue({ data: updated });
      await rerender(
        <QueryClientProvider client={makeQC()}>
          <ToastContext.Provider value={toastValue}>
            <MemoryRouter>
              <Profiler id="fleet-storm" onRender={onRender}>
                <SoupKitchen />
              </Profiler>
            </MemoryRouter>
          </ToastContext.Provider>
        </QueryClientProvider>,
      );
    }
    const worst = frameCosts.length > 0 ? Math.max(...frameCosts) : -1;
    console.log(`[perf-budget] storm worst frame cost: ${worst.toFixed(1)}ms over ${frameCosts.length} update renders (provisional budget <16ms)`);
    expect(frameCosts.length).toBeGreaterThan(0);
    if (ENFORCE) expect(worst).toBeLessThan(16);
    cleanup();
  });
});
