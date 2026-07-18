/**
 * MetricsTab — behavior coverage for console/src/components/line-detail/MetricsTab.tsx.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { LineInstance, LineMetrics, MetricsRange } from '../../console/src/types';

const metricsChartMock = vi.fn();
const fleetTokenChartMock = vi.fn();
const fleetSessionChartMock = vi.fn();
const activeHoursMock = vi.fn();
const metricsToCSVMock = vi.fn();
const downloadCSVMock = vi.fn();

vi.mock('../../console/src/components/MetricsChart', () => ({
  MetricsChart: (props: unknown) => {
    metricsChartMock(props);
    return <div data-testid="metrics-chart" />;
  },
}));

vi.mock('../../console/src/components/FleetTokenChart', () => ({
  FleetTokenChart: (props: unknown) => {
    fleetTokenChartMock(props);
    return <div data-testid="fleet-token-chart" />;
  },
}));

vi.mock('../../console/src/components/FleetSessionChart', () => ({
  FleetSessionChart: (props: unknown) => {
    fleetSessionChartMock(props);
    return <div data-testid="fleet-session-chart" />;
  },
}));

vi.mock('../../console/src/components/ActiveHoursHeatmap', () => ({
  ActiveHoursHeatmap: (props: unknown) => {
    activeHoursMock(props);
    return <div data-testid="active-hours-heatmap" />;
  },
}));

vi.mock('../../console/src/lib/csv-export', () => ({
  metricsToCSV: (...args: unknown[]) => metricsToCSVMock(...args),
  downloadCSV: (...args: unknown[]) => downloadCSVMock(...args),
}));

const { MetricsTab } = await import('../../console/src/components/line-detail/MetricsTab');

function buildMetrics(overrides: Partial<LineMetrics> = {}): LineMetrics {
  return {
    range: '24h',
    messageVolume: [
      { bucket: '2026-05-12T00:00:00.000Z', inbound: 4, outbound: 2, media: 1 },
    ],
    tokenUsage: [{ bucket: '2026-05-12T00:00:00.000Z', input: 10, output: 5 }],
    sessionActivity: [{ bucket: '2026-05-12T00:00:00.000Z', active: 2, started: 1 }],
    tokenUsageByProvider: {},
    sessionActivityByProvider: {},
    activeHours: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0)),
    activeHoursByDate: [],
    hasMessageData: true,
    hasTokenData: true,
    hasSessionData: true,
    providers: ['anthropic'],
    ...overrides,
  };
}

function noopRange(): MetricsRange {
  return '24h';
}

afterEach(() => {
  cleanup();
  metricsChartMock.mockReset();
  fleetTokenChartMock.mockReset();
  fleetSessionChartMock.mockReset();
  activeHoursMock.mockReset();
  metricsToCSVMock.mockReset();
  downloadCSVMock.mockReset();
});

describe('MetricsTab — range selector', () => {
  it('renders the three supported ranges and marks the active one via aria-pressed', () => {
    const setRange = vi.fn();
    render(
      <MetricsTab
        metrics={buildMetrics()}
        metricsLoading={false}
        metricsError={null}
        metricsRange="7d"
        setMetricsRange={setRange}
      />,
    );

    // ToolbarTimeRange renders role="group" with aria-label
    const seg = screen.getByRole('group', { name: 'Time range' });
    expect(seg).toBeTruthy();

    const button24h = screen.getByRole('button', { name: '24h' });
    const button7d = screen.getByRole('button', { name: '7d' });
    const button30d = screen.getByRole('button', { name: '30d' });

    // Exactly one button pressed (the active range)
    expect(button24h.getAttribute('aria-pressed')).toBe('false');
    expect(button7d.getAttribute('aria-pressed')).toBe('true');
    expect(button30d.getAttribute('aria-pressed')).toBe('false');
  });

  it('maintains exactly-one aria-pressed after a click', () => {
    const setRange = vi.fn();
    const { rerender } = render(
      <MetricsTab
        metrics={buildMetrics()}
        metricsLoading={false}
        metricsError={null}
        metricsRange="24h"
        setMetricsRange={setRange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '30d' }));
    expect(setRange).toHaveBeenCalledWith('30d');

    // Simulate controlled re-render with new value
    rerender(
      <MetricsTab
        metrics={buildMetrics()}
        metricsLoading={false}
        metricsError={null}
        metricsRange="30d"
        setMetricsRange={setRange}
      />,
    );

    const pressedButtons = screen
      .getAllByRole('button')
      .filter((b) => b.closest('[aria-label="Time range"]') && b.getAttribute('aria-pressed') === 'true');
    expect(pressedButtons).toHaveLength(1);
    expect(pressedButtons[0].textContent).toBe('30d');
  });

  it('invokes setMetricsRange with the clicked range token', () => {
    const setRange = vi.fn();
    render(
      <MetricsTab
        metrics={buildMetrics()}
        metricsLoading={false}
        metricsError={null}
        metricsRange="24h"
        setMetricsRange={setRange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '30d' }));
    fireEvent.click(screen.getByRole('button', { name: '7d' }));

    expect(setRange).toHaveBeenCalledTimes(2);
    expect(setRange).toHaveBeenNthCalledWith(1, '30d');
    expect(setRange).toHaveBeenNthCalledWith(2, '7d');
  });
});

describe('MetricsTab — state branches', () => {
  it('renders the loading EmptyState when metricsLoading is true', () => {
    render(
      <MetricsTab
        metrics={undefined}
        metricsLoading={true}
        metricsError={null}
        metricsRange={noopRange()}
        setMetricsRange={vi.fn()}
      />,
    );

    expect(screen.getByText('Loading metrics...')).toBeTruthy();
    expect(screen.queryByTestId('metrics-chart')).toBeNull();
    expect(screen.queryByTestId('active-hours-heatmap')).toBeNull();
  });

  it('renders the error EmptyState with the error message and wires onRetry', () => {
    const onRetry = vi.fn();
    render(
      <MetricsTab
        metrics={undefined}
        metricsLoading={false}
        metricsError={new Error('boom')}
        metricsRange={noopRange()}
        setMetricsRange={vi.fn()}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText('Failed to load metrics')).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();

    const retry = screen.getByRole('button', { name: /try again/i });
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders the empty-data EmptyState when no data flags are set', () => {
    const metrics = buildMetrics({
      hasMessageData: false,
      hasTokenData: false,
      hasSessionData: false,
    });
    render(
      <MetricsTab
        metrics={metrics}
        metricsLoading={false}
        metricsError={null}
        metricsRange={noopRange()}
        setMetricsRange={vi.fn()}
      />,
    );

    expect(screen.getByText('No metrics data')).toBeTruthy();
    expect(screen.queryByTestId('metrics-chart')).toBeNull();
    expect(screen.queryByTestId('fleet-token-chart')).toBeNull();
    expect(screen.queryByTestId('fleet-session-chart')).toBeNull();
  });
});

describe('MetricsTab — chart wiring', () => {
  it('forwards messageVolume + range to MetricsChart when hasMessageData', () => {
    const metrics = buildMetrics();
    render(
      <MetricsTab
        metrics={metrics}
        metricsLoading={false}
        metricsError={null}
        metricsRange="7d"
        setMetricsRange={vi.fn()}
      />,
    );

    expect(screen.getByTestId('metrics-chart')).toBeTruthy();
    expect(screen.getByText('Message Volume')).toBeTruthy();
    expect(metricsChartMock).toHaveBeenCalledTimes(1);
    expect(metricsChartMock.mock.calls[0][0]).toMatchObject({
      data: metrics.messageVolume,
      range: '7d',
    });
  });

  it('skips the Message Volume card when hasMessageData is false but renders heatmap', () => {
    const metrics = buildMetrics({ hasMessageData: false });
    render(
      <MetricsTab
        metrics={metrics}
        metricsLoading={false}
        metricsError={null}
        metricsRange="24h"
        setMetricsRange={vi.fn()}
      />,
    );

    expect(screen.queryByText('Message Volume')).toBeNull();
    expect(metricsChartMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('active-hours-heatmap')).toBeTruthy();
    expect(activeHoursMock.mock.calls[0][0]).toMatchObject({
      data: metrics.activeHours,
      byDate: metrics.activeHoursByDate,
      range: '24h',
    });
  });

  it('omits the heatmap when metrics.activeHours is missing', () => {
    // activeHours is required by the type but the runtime guard is `metrics?.activeHours`;
    // simulate a payload that left it out.
    const metrics = buildMetrics();
    delete (metrics as Partial<LineMetrics>).activeHours;

    render(
      <MetricsTab
        metrics={metrics}
        metricsLoading={false}
        metricsError={null}
        metricsRange="24h"
        setMetricsRange={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('active-hours-heatmap')).toBeNull();
    expect(activeHoursMock).not.toHaveBeenCalled();
  });
});

describe('MetricsTab — detail tab', () => {
  it('defaults to Tokens, forwards token data, and hides the Sessions chart', () => {
    const metrics = buildMetrics();
    render(
      <MetricsTab
        metrics={metrics}
        metricsLoading={false}
        metricsError={null}
        metricsRange="30d"
        setMetricsRange={vi.fn()}
      />,
    );

    expect(screen.getByTestId('fleet-token-chart')).toBeTruthy();
    expect(screen.queryByTestId('fleet-session-chart')).toBeNull();
    expect(fleetTokenChartMock.mock.calls[0][0]).toMatchObject({
      data: metrics.tokenUsage,
      byProvider: metrics.tokenUsageByProvider,
      providers: metrics.providers,
      range: '30d',
    });

    const tabs = screen.getByRole('tablist', { name: 'Metric detail series' });
    const tokensTab = screen.getByRole('tab', { name: 'Tokens' });
    const sessionsTab = screen.getByRole('tab', { name: 'Sessions' });
    expect(tabs).toBeTruthy();
    expect(tokensTab.getAttribute('aria-selected')).toBe('true');
    expect(sessionsTab.getAttribute('aria-selected')).toBe('false');
    expect(tokensTab.className).toContain('soup-tab--selected');
  });

  it('switches to the Sessions chart when the Sessions tab is clicked', () => {
    const metrics = buildMetrics();
    render(
      <MetricsTab
        metrics={metrics}
        metricsLoading={false}
        metricsError={null}
        metricsRange="24h"
        setMetricsRange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }));

    expect(screen.getByTestId('fleet-session-chart')).toBeTruthy();
    expect(screen.queryByTestId('fleet-token-chart')).toBeNull();
    expect(fleetSessionChartMock).toHaveBeenCalledTimes(1);
    expect(fleetSessionChartMock.mock.calls[0][0]).toMatchObject({
      data: metrics.sessionActivity,
      byProvider: metrics.sessionActivityByProvider,
      providers: metrics.providers,
      range: '24h',
    });
  });

  it('hides the detail card entirely when neither token nor session data exists', () => {
    const metrics = buildMetrics({ hasTokenData: false, hasSessionData: false });
    render(
      <MetricsTab
        metrics={metrics}
        metricsLoading={false}
        metricsError={null}
        metricsRange="24h"
        setMetricsRange={vi.fn()}
      />,
    );

    // The hero chart still renders because hasMessageData is true.
    expect(screen.getByTestId('metrics-chart')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Tokens' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Sessions' })).toBeNull();
    expect(screen.queryByTestId('fleet-token-chart')).toBeNull();
    expect(screen.queryByTestId('fleet-session-chart')).toBeNull();
  });

  it('shows only Sessions when token data is absent and renders the Sessions chart immediately', () => {
    const metrics = buildMetrics({ hasTokenData: false });
    render(
      <MetricsTab
        metrics={metrics}
        metricsLoading={false}
        metricsError={null}
        metricsRange="24h"
        setMetricsRange={vi.fn()}
      />,
    );

    expect(screen.queryByRole('tab', { name: 'Tokens' })).toBeNull();
    const sessionsTab = screen.getByRole('tab', { name: 'Sessions' });
    expect(sessionsTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByTestId('fleet-token-chart')).toBeNull();
    expect(screen.getByTestId('fleet-session-chart')).toBeTruthy();
  });

  it('uses manual Tabs activation for keyboard focus movement', () => {
    const metrics = buildMetrics();
    render(
      <MetricsTab
        metrics={metrics}
        metricsLoading={false}
        metricsError={null}
        metricsRange="24h"
        setMetricsRange={vi.fn()}
      />,
    );

    const tokensTab = screen.getByRole('tab', { name: 'Tokens' });
    const sessionsTab = screen.getByRole('tab', { name: 'Sessions' });

    tokensTab.focus();
    fireEvent.keyDown(tokensTab, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(sessionsTab);
    expect(screen.getByTestId('fleet-token-chart')).toBeTruthy();
    expect(screen.queryByTestId('fleet-session-chart')).toBeNull();

    fireEvent.keyDown(sessionsTab, { key: 'Enter' });
    expect(screen.getByTestId('fleet-session-chart')).toBeTruthy();
    expect(screen.queryByTestId('fleet-token-chart')).toBeNull();
  });
});

describe('MetricsTab — CSV export', () => {
  it('renders the export button only when messageVolume has rows', () => {
    const metrics = buildMetrics({ messageVolume: [] });
    render(
      <MetricsTab
        metrics={metrics}
        metricsLoading={false}
        metricsError={null}
        metricsRange="24h"
        setMetricsRange={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText('Export metrics as CSV')).toBeNull();
  });

  it('builds a CSV from messageVolume and downloads it with lineName + range filename', () => {
    metricsToCSVMock.mockReturnValue('bucket,inbound,outbound\nx,1,2');
    const metrics = buildMetrics();

    render(
      <MetricsTab
        metrics={metrics}
        metricsLoading={false}
        metricsError={null}
        metricsRange="7d"
        setMetricsRange={vi.fn()}
        lineName="loops"
      />,
    );

    fireEvent.click(screen.getByLabelText('Export metrics as CSV'));

    expect(metricsToCSVMock).toHaveBeenCalledTimes(1);
    expect(metricsToCSVMock).toHaveBeenCalledWith(metrics.messageVolume);
    expect(downloadCSVMock).toHaveBeenCalledTimes(1);
    expect(downloadCSVMock).toHaveBeenCalledWith('bucket,inbound,outbound\nx,1,2', 'loops-7d.csv');
  });

  it('falls back to "metrics" in the filename when lineName is omitted', () => {
    metricsToCSVMock.mockReturnValue('header');
    render(
      <MetricsTab
        metrics={buildMetrics()}
        metricsLoading={false}
        metricsError={null}
        metricsRange="30d"
        setMetricsRange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText('Export metrics as CSV'));
    expect(downloadCSVMock).toHaveBeenCalledWith('header', 'metrics-30d.csv');
  });
});

describe('MetricsTab — Token Usage card', () => {
  const line: LineInstance = {
    name: 'loops',
    mode: 'agent',
    status: { state: 'ready' },
    heartbeat: [],
    lastActive: '',
    error: null,
    tokenUsage: { input: 1000, output: 250 },
  } as unknown as LineInstance;

  it('renders the totals card with localized numbers when token totals are positive', () => {
    render(
      <MetricsTab
        metrics={buildMetrics()}
        metricsLoading={false}
        metricsError={null}
        metricsRange="24h"
        setMetricsRange={vi.fn()}
        line={line}
      />,
    );

    expect(screen.getByText('Token Usage')).toBeTruthy();
    expect(screen.getByText('1,000')).toBeTruthy();
    expect(screen.getByText('250')).toBeTruthy();
    expect(screen.getByText('1,250')).toBeTruthy();
  });

  it('hides the totals card when both token totals are zero', () => {
    const zeroLine = { ...line, tokenUsage: { input: 0, output: 0 } } as LineInstance;
    render(
      <MetricsTab
        metrics={buildMetrics()}
        metricsLoading={false}
        metricsError={null}
        metricsRange="24h"
        setMetricsRange={vi.fn()}
        line={zeroLine}
      />,
    );

    expect(screen.queryByText('Token Usage')).toBeNull();
  });

  it('hides the totals card entirely when line.tokenUsage is absent', () => {
    const bareLine = { ...line, tokenUsage: undefined } as LineInstance;
    render(
      <MetricsTab
        metrics={buildMetrics()}
        metricsLoading={false}
        metricsError={null}
        metricsRange="24h"
        setMetricsRange={vi.fn()}
        line={bareLine}
      />,
    );

    expect(screen.queryByText('Token Usage')).toBeNull();
  });
});

describe('MetricsTab — Model Configuration card', () => {
  const line: LineInstance = {
    name: 'loops',
    mode: 'agent',
    status: { state: 'ready' },
    heartbeat: [],
    lastActive: '',
    error: null,
    models: {
      conversation: 'claude-opus',
      fallback: undefined,
      extraction: 'gpt-4o-mini',
      validation: undefined,
    },
  } as unknown as LineInstance;

  it('renders one row per non-empty role and skips empty entries', () => {
    render(
      <MetricsTab
        metrics={buildMetrics()}
        metricsLoading={false}
        metricsError={null}
        metricsRange="24h"
        setMetricsRange={vi.fn()}
        line={line}
      />,
    );

    expect(screen.getByText('Model Configuration')).toBeTruthy();
    expect(screen.getByText('conversation')).toBeTruthy();
    expect(screen.getByText('claude-opus')).toBeTruthy();
    expect(screen.getByText('extraction')).toBeTruthy();
    expect(screen.getByText('gpt-4o-mini')).toBeTruthy();
    // Empty roles are skipped.
    expect(screen.queryByText('fallback')).toBeNull();
    expect(screen.queryByText('validation')).toBeNull();
  });

  it('hides the Model Configuration card when line.models is absent', () => {
    const bareLine = { ...line, models: undefined } as LineInstance;
    render(
      <MetricsTab
        metrics={buildMetrics()}
        metricsLoading={false}
        metricsError={null}
        metricsRange="24h"
        setMetricsRange={vi.fn()}
        line={bareLine}
      />,
    );

    expect(screen.queryByText('Model Configuration')).toBeNull();
  });
});

describe('MetricsTab freshness marker (GUI-5)', () => {
  it('labels carried data stale with the amber idiom, payload still rendered', () => {
    render(
      <MetricsTab
        metrics={buildMetrics()}
        metricsLoading={false}
        metricsError={null}
        metricsRange="24h"
        setMetricsRange={() => {}}
        metricsFreshness={{ observedAt: Date.now() - 121_000, stale: true }}
      />,
    )

    const marker = screen.getByText(/^stale · /)
    expect(marker.className).toContain('c-label')
    expect(marker.className).toContain('text-s-warn')
    // stale labels, never hides: the payload charts still render
    expect(screen.getAllByTestId('metrics-chart').length).toBeGreaterThan(0)
  })

  it('shows a quiet observation age for fresh data without the warn styling', () => {
    render(
      <MetricsTab
        metrics={buildMetrics()}
        metricsLoading={false}
        metricsError={null}
        metricsRange="24h"
        setMetricsRange={() => {}}
        metricsFreshness={{ observedAt: Date.now() - 5_000, stale: false }}
      />,
    )

    const marker = screen.getByText(/^observed /)
    expect(marker.className).toContain('c-label')
    expect(marker.className).not.toContain('text-s-warn')
  })

  it('renders no freshness marker before the first observation', () => {
    render(
      <MetricsTab
        metrics={buildMetrics()}
        metricsLoading={false}
        metricsError={null}
        metricsRange="24h"
        setMetricsRange={() => {}}
        metricsFreshness={{ observedAt: null, stale: false }}
      />,
    )

    expect(screen.queryByText(/^stale · /)).toBeNull()
    expect(screen.queryByText(/^observed /)).toBeNull()
  })

  it('renders no marker when the prop is omitted (legacy callers)', () => {
    render(
      <MetricsTab
        metrics={buildMetrics()}
        metricsLoading={false}
        metricsError={null}
        metricsRange="24h"
        setMetricsRange={() => {}}
      />,
    )

    expect(screen.queryByText(/^stale · /)).toBeNull()
    expect(screen.queryByText(/^observed /)).toBeNull()
  })
})
