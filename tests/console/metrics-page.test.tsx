/**
 * Ops Metrics tab — behavior tests (T5 b-09a absorption).
 *
 * DISPOSITION RECORD: this suite previously pinned the /metrics PAGE. The
 * page's content was absorbed into the Ops surface as the Metrics tab
 * (OpsMetrics) — /metrics now redirects to /ops?tab=metrics. Every pin
 * below targets the same hooks + anatomy in the absorbed component; the
 * only deletion is the page wrapper itself (the Operator tab shell and the
 * redirect are pinned in ops-metrics-tab.test.tsx).
 *
 * Renders the real OpsMetrics destination under jsdom + Testing Library and
 * asserts on observable DOM. The component COMPOSES existing fleet pieces:
 *   - KPI cells from useLines (computeKpis) + useFleetMetrics (msg/token totals)
 *   - FleetMetricsChart (message-volume bars) + FleetTokenChart (token donut),
 *     each framed in ChartPanel for loading / empty / error states.
 *
 * recharts is stubbed with a semantic boundary (same idiom as
 * fleet-metrics-chart.test.tsx) so the chart bodies render under jsdom's
 * zero-size ResponsiveContainer.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const useLinesMock = vi.hoisted(() => vi.fn());
const useFeedMock = vi.hoisted(() => vi.fn());
const useFleetMetricsMock = vi.hoisted(() => vi.fn());

vi.mock('../../console/src/hooks/use-fleet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../console/src/hooks/use-fleet')>();
  return { ...actual, useLines: useLinesMock, useFeed: useFeedMock };
});

vi.mock('../../console/src/hooks/use-metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../console/src/hooks/use-metrics')>();
  return { ...actual, useFleetMetrics: useFleetMetricsMock };
});

// Recharts stub — render children inside a labelled region so the chart body
// is observable; the real ResponsiveContainer collapses to nothing at the
// zero measured size jsdom reports.
vi.mock('recharts', async () => {
  const React = await import('react');
  return {
    ResponsiveContainer({ children }: { children?: React.ReactNode }) {
      return <div data-testid="chart-body">{children}</div>;
    },
    BarChart({ children }: { children?: React.ReactNode }) {
      return <div aria-label="Stacked message volume" role="group">{children}</div>;
    },
    PieChart({ children }: { children?: React.ReactNode }) {
      return <div aria-label="Token spend ring" role="group">{children}</div>;
    },
    Bar: () => null,
    Pie: () => null,
    Cell: () => null,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Legend: () => null,
  };
});

// framer-motion probes prefers-reduced-motion via matchMedia, absent in jsdom.
beforeEach(() => {
  if (typeof window !== 'undefined' && !window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
  }
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

import { OpsMetrics } from '../../console/src/components/ops/OpsMetrics';
import type { FleetMetrics, LineInstance } from '../../console/src/types';

// ---------------------------------------------------------------------------
// Fixtures + render helper
// ---------------------------------------------------------------------------

function makeLine(overrides: Partial<LineInstance> = {}): LineInstance {
  return {
    name: 'test-line',
    phone: '+15550001234',
    mode: 'passive',
    status: 'online',
    accessMode: 'open',
    healthPort: 9100,
    uptime: '2h',
    messagesTotal: 50,
    health: null,
    heartbeat: [],
    lastActive: new Date().toISOString(),
    error: null,
    ...overrides,
  };
}

function makeFleetMetrics(overrides: Partial<FleetMetrics> = {}): FleetMetrics {
  return {
    range: '24h',
    meta: {
      instancesQueried: 2,
      instancesFailed: 0,
      hasMessageData: true,
      hasTokenData: true,
      hasSessionData: true,
      providers: ['claude-cli', 'openai'],
    },
    messageVolume: [
      { bucket: '2026-06-17T00:00:00Z', inbound: 10, outbound: 6, media: 2 },
      { bucket: '2026-06-17T01:00:00Z', inbound: 4, outbound: 3, media: 1 },
    ],
    tokenUsage: [
      { bucket: '2026-06-17T00:00:00Z', input: 8000, output: 3000 },
      { bucket: '2026-06-17T01:00:00Z', input: 600, output: 400 },
    ],
    sessionActivity: [],
    tokenUsageByProvider: {
      'claude-cli': [{ bucket: '2026-06-17T00:00:00Z', input: 6000, output: 2000 }],
      openai: [{ bucket: '2026-06-17T00:00:00Z', input: 2600, output: 1400 }],
    },
    sessionActivityByProvider: {},
    ...overrides,
  };
}

interface RenderOptions {
  lines?: LineInstance[];
  linesError?: Error | null;
  linesRefetch?: ReturnType<typeof vi.fn>;
  fleetMetrics?: FleetMetrics | null;
  metricsLoading?: boolean;
  metricsError?: boolean;
  metricsRefetch?: ReturnType<typeof vi.fn>;
  metricsFreshness?: { observedAt: number | null; stale: boolean };
}

function renderPage(opts: RenderOptions = {}) {
  useLinesMock.mockReturnValue({
    data: opts.lines ?? [],
    isError: Boolean(opts.linesError),
    error: opts.linesError ?? null,
    refetch: opts.linesRefetch ?? vi.fn(),
  });
  useFeedMock.mockReturnValue({
    data: [],
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
  useFleetMetricsMock.mockReturnValue({
    data: opts.fleetMetrics === undefined ? makeFleetMetrics() : opts.fleetMetrics ?? undefined,
    isLoading: Boolean(opts.metricsLoading),
    isError: Boolean(opts.metricsError),
    refetch: opts.metricsRefetch ?? vi.fn(),
    freshness: opts.metricsFreshness,
  });

  return render(
    <MemoryRouter>
      <OpsMetrics />
    </MemoryRouter>,
  );
}

/** KPI labels live in a .c-label span inside the enclosing card button. */
function kpiCard(label: string | RegExp): HTMLElement {
  const candidates = screen
    .getAllByText(label)
    .filter((el) => el.className.includes('c-label'));
  if (candidates.length !== 1) {
    throw new Error(`Expected 1 KPI label for "${label}", found ${candidates.length}`);
  }
  const card = candidates[0].closest('button');
  if (!card) throw new Error(`KPI card "${label}" has no enclosing button`);
  return card as HTMLElement;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Ops metrics tab — KPI cells', () => {
  it('renders the fleet KPI cells with aggregated values', () => {
    const lines = [
      makeLine({ name: 'a', status: 'online' }),
      makeLine({ name: 'b', status: 'online' }),
      makeLine({ name: 'c', status: 'unreachable', error: 'down' }),
    ];
    renderPage({ lines });

    // Total Lines = 3
    expect(within(kpiCard('Total Lines')).getByText('3')).toBeDefined();
    // Lines Online = 2 (status === 'online')
    expect(within(kpiCard('Lines Online')).getByText('2')).toBeDefined();
    // Need Attention = 1 (the errored line)
    expect(within(kpiCard('Need Attention')).getByText('1')).toBeDefined();
    // Messages (24h) = 10+6+2 + 4+3+1 = 26
    expect(within(kpiCard(/Messages/)).getByText('26')).toBeDefined();
    // Tokens (24h) = 8000+3000 + 600+400 = 12000 → compact "12K"
    expect(within(kpiCard(/Tokens/)).getByText('12K')).toBeDefined();
  });

  it('labels the health-state count "Lines Online" and excludes a degraded-but-connected line (#1881)', () => {
    // #1881: "Online" (health-state) and "Connected" (transport-state) are
    // distinct dimensions. A degraded line whose WhatsApp transport is up
    // counts toward the Fleet transport-state "Lines Connected" KPI, but the
    // Metrics "Lines Online" tile is a HEALTH-STATE count and must NOT include
    // it — otherwise the label lies about what it measures.
    const lines = [
      makeLine({ name: 'a', status: 'online' }),
      makeLine({
        name: 'b',
        status: 'degraded',
        health: {
          status: 'ok',
          uptime_seconds: 1,
          messages_total: 0,
          whatsapp: { connected: true, connection: { state: 'connected' } },
          sqlite: { messages_total: 0, schema_version: 5 },
        },
      }),
    ];
    renderPage({ lines });

    // Health-state Online = 1 (only the status==='online' line). The degraded-
    // but-connected line is a transport count, not a health-state one.
    expect(within(kpiCard('Lines Online')).getByText('1')).toBeDefined();
    // It is still surfaced as needing attention (health-state = degraded).
    expect(within(kpiCard('Need Attention')).getByText('1')).toBeDefined();
  });

  it('shows zeroed KPIs when no lines and no metrics exist', () => {
    renderPage({ lines: [], fleetMetrics: null });

    expect(within(kpiCard('Total Lines')).getByText('0')).toBeDefined();
    expect(within(kpiCard('Lines Online')).getByText('0')).toBeDefined();
    expect(within(kpiCard('Need Attention')).getByText('0')).toBeDefined();
  });
});

describe('Ops metrics tab — charts', () => {
  it('renders both charts framed in panels when data is present', () => {
    renderPage({ lines: [makeLine()] });

    // ChartPanel section labels.
    expect(screen.getByText(/Message Volume \(24h\)/)).toBeDefined();
    expect(screen.getByText(/Token Usage \(24h\)/)).toBeDefined();
    // Both chart bodies render (recharts stub regions).
    expect(screen.getByRole('group', { name: 'Stacked message volume' })).toBeDefined();
    expect(screen.getByRole('group', { name: 'Token spend ring' })).toBeDefined();
  });

  it('shows the loading shimmer in both panels while metrics load', () => {
    renderPage({ lines: [makeLine()], fleetMetrics: null, metricsLoading: true });

    const shimmers = screen.getAllByTestId('chart-shimmer');
    expect(shimmers).toHaveLength(2);
  });

  it('shows the empty state when there is no chart data', () => {
    const empty = makeFleetMetrics({
      messageVolume: [],
      tokenUsage: [],
      meta: {
        instancesQueried: 0,
        instancesFailed: 0,
        hasMessageData: false,
        hasTokenData: false,
        hasSessionData: false,
        providers: [],
      },
    });
    renderPage({ lines: [makeLine()], fleetMetrics: empty });

    expect(screen.getAllByText('No data yet')).toHaveLength(2);
  });

  it('shows the error state and a retry control when metrics fail', () => {
    renderPage({ lines: [makeLine()], fleetMetrics: null, metricsError: true });

    expect(screen.getAllByText('Failed to load')).toHaveLength(2);
  });

  it('surfaces a fleet-data error message when useLines fails', () => {
    renderPage({ lines: [], linesError: new Error('boom') });

    expect(screen.getByText(/Fleet data unavailable: boom/)).toBeDefined();
  });
});

describe('Ops metrics tab — freshness caption (GUI-5)', () => {
  it('labels carried fleet metrics with an amber stale caption', () => {
    renderPage({ metricsFreshness: { observedAt: Date.now() - 300_000, stale: true } });
    const marker = screen.getByText(/^stale · /);
    expect(marker.className).toContain('c-label');
    expect(marker.className).toContain('text-s-warn');
  });

  it('shows a quiet observation caption for fresh fleet metrics', () => {
    renderPage({ metricsFreshness: { observedAt: Date.now() - 5_000, stale: false } });
    const marker = screen.getByText(/^observed /);
    expect(marker.className).toContain('c-label');
    expect(marker.className).not.toContain('text-s-warn');
  });

  it('renders no caption when freshness is unavailable', () => {
    renderPage();
    expect(screen.queryByText(/^stale · /)).toBeNull();
    expect(screen.queryByText(/^observed /)).toBeNull();
  });
});
