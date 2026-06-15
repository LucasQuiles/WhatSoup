/**
 * FleetMetricsChart - rendered behavior through a semantic Recharts boundary.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { MessageVolumeBucket } from '../../console/src/types.js';
import { FleetMetricsChart } from '../../console/src/components/FleetMetricsChart';

vi.mock('recharts', async () => {
  const React = await import('react');

  type ChartDatum = Record<string, string | number>;
  type Formatter = (value: string | number) => string;

  const ChartDataContext = React.createContext<ChartDatum[]>([]);

  function valueFor(data: ChartDatum[], key: string | undefined): string[] {
    if (!key) return [];
    return data.map((datum) => String(datum[key] ?? ''));
  }

  return {
    ResponsiveContainer({ children }: { children?: React.ReactNode }) {
      return (
        <section aria-label="Fleet message volume chart" role="region">
          {children}
        </section>
      );
    },
    AreaChart({ data = [], children }: { data?: ChartDatum[]; children?: React.ReactNode }) {
      return (
        <ChartDataContext.Provider value={data}>
          <div aria-label="Stacked message volume" role="group">
            {children}
          </div>
        </ChartDataContext.Provider>
      );
    },
    CartesianGrid() {
      return <div aria-label="Chart grid" role="presentation" />;
    },
    XAxis({ dataKey, tickFormatter }: { dataKey?: string; tickFormatter?: Formatter }) {
      const data = React.useContext(ChartDataContext);
      const labels = valueFor(data, dataKey).map((value) => tickFormatter?.(value) ?? value);

      return (
        <div aria-label="Time axis" role="group">
          {labels.map((label, index) => (
            <span key={`${label}-${index}`}>{label}</span>
          ))}
        </div>
      );
    },
    YAxis() {
      return (
        <div aria-label="Message count axis" role="group">
          Messages
        </div>
      );
    },
    Tooltip({ labelFormatter }: { labelFormatter?: (value: string | number) => string }) {
      const [first] = React.useContext(ChartDataContext);
      if (!first) return null;

      const label = labelFormatter?.(first.bucket) ?? String(first.bucket);
      return <output aria-label="Active bucket label">{label}</output>;
    },
    Legend() {
      return (
        <div aria-label="Chart legend" role="group">
          Legend
        </div>
      );
    },
    Area({
      dataKey,
      fill,
      fillOpacity,
      name,
      stroke,
    }: {
      dataKey?: string;
      fill?: string;
      fillOpacity?: number;
      name?: string;
      stroke?: string;
    }) {
      const data = React.useContext(ChartDataContext);
      const seriesName = name ?? dataKey ?? 'Series';

      return (
        <section
          aria-label={`${seriesName} series`}
          data-fill={fill}
          data-fill-opacity={fillOpacity}
          data-stroke={stroke}
          role="region"
        >
          <h3>{seriesName}</h3>
          <ul aria-label={`${seriesName} data points`}>
            {data.map((datum) => (
              <li key={`${seriesName}-${datum.bucket}`}>
                {seriesName}: {String(datum.bucket)} - {String(datum[dataKey ?? ''])} messages
              </li>
            ))}
          </ul>
        </section>
      );
    },
  };
});

afterEach(() => cleanup());

const SAMPLE: MessageVolumeBucket[] = [
  { bucket: '2026-04-05T18:00:00.000Z', inbound: 4, outbound: 2, media: 1 },
  { bucket: '2026-04-05T19:00:00.000Z', inbound: 6, outbound: 3, media: 0 },
];

function chart() {
  return screen.getByRole('region', { name: 'Fleet message volume chart' });
}

function series(name: string) {
  return within(chart()).getByRole('region', { name: `${name} series` });
}

describe('FleetMetricsChart', () => {
  it('renders the chart frame, axes, tooltip label, legend, and stacked message series', () => {
    render(<FleetMetricsChart data={SAMPLE} />);

    expect(chart()).toBeDefined();
    expect(within(chart()).getByRole('group', { name: 'Stacked message volume' })).toBeDefined();
    expect(within(chart()).getByRole('group', { name: 'Time axis' })).toBeDefined();
    expect(within(chart()).getByRole('group', { name: 'Message count axis' })).toBeDefined();
    expect(within(chart()).getByRole('group', { name: 'Chart legend' })).toBeDefined();
    expect(within(chart()).getByLabelText('Active bucket label').textContent).not.toContain('2026-04-05T18:00:00.000Z');

    expect(within(series('Inbound')).getByRole('heading', { name: 'Inbound' })).toBeDefined();
    expect(within(series('Outbound')).getByRole('heading', { name: 'Outbound' })).toBeDefined();
    expect(within(series('Media')).getByRole('heading', { name: 'Media' })).toBeDefined();

    expect(within(series('Inbound')).getByText(/Inbound: .* - 4 messages/)).toBeDefined();
    expect(within(series('Inbound')).getByText(/Inbound: .* - 6 messages/)).toBeDefined();
    expect(within(series('Outbound')).getByText(/Outbound: .* - 2 messages/)).toBeDefined();
    expect(within(series('Outbound')).getByText(/Outbound: .* - 3 messages/)).toBeDefined();
    expect(within(series('Media')).getByText(/Media: .* - 1 messages/)).toBeDefined();
    expect(within(series('Media')).getByText(/Media: .* - 0 messages/)).toBeDefined();
  });

  it('uses range-aware labels for the visible time axis and active tooltip bucket', () => {
    const { rerender } = render(<FleetMetricsChart data={SAMPLE} />);

    const defaultAxis = within(chart()).getByRole('group', { name: 'Time axis' }).textContent;
    const defaultTooltip = within(chart()).getByLabelText('Active bucket label').textContent;

    rerender(<FleetMetricsChart data={SAMPLE} range="7d" />);
    const weeklyAxis = within(chart()).getByRole('group', { name: 'Time axis' }).textContent;
    const weeklyTooltip = within(chart()).getByLabelText('Active bucket label').textContent;

    rerender(<FleetMetricsChart data={SAMPLE} range="30d" />);
    const monthlyAxis = within(chart()).getByRole('group', { name: 'Time axis' }).textContent;
    const monthlyTooltip = within(chart()).getByLabelText('Active bucket label').textContent;

    expect(defaultAxis).toBeTruthy();
    expect(defaultTooltip).toBeTruthy();
    expect(weeklyAxis).toBeTruthy();
    expect(weeklyTooltip).toBeTruthy();
    expect(monthlyAxis).toBeTruthy();
    expect(monthlyTooltip).toBeTruthy();

    expect(defaultAxis).not.toBe(weeklyAxis);
    expect(weeklyAxis).not.toBe(monthlyAxis);
    expect(defaultTooltip).not.toBe(weeklyTooltip);
    expect(weeklyTooltip).not.toBe(monthlyTooltip);
  });

  it('keeps the chart semantics and series labels when there are no message buckets', () => {
    render(<FleetMetricsChart data={[]} range="30d" />);

    expect(chart()).toBeDefined();
    expect(within(chart()).getByRole('group', { name: 'Time axis' })).toBeDefined();
    expect(within(chart()).queryByLabelText('Active bucket label')).toBeNull();

    for (const name of ['Inbound', 'Outbound', 'Media']) {
      expect(within(series(name)).getByRole('heading', { name })).toBeDefined();
      expect(within(series(name)).queryAllByRole('listitem')).toHaveLength(0);
    }
  });

  it('uses the data-series token palette for aggregate message dimensions', () => {
    render(<FleetMetricsChart data={SAMPLE} />);

    const expected = {
      Inbound: 'var(--data-inbound-solid)',
      Outbound: 'var(--data-outbound-solid)',
      Media: 'var(--data-media-solid)',
    };

    for (const [name, token] of Object.entries(expected)) {
      const region = series(name);
      expect(region.getAttribute('data-stroke')).toBe(token);
      expect(region.getAttribute('data-fill')).toBe(token);
      expect(region.getAttribute('data-stroke')).not.toMatch(/--(?:color-[ms]-|provider-|status-|mode-)/);
    }
  });
});
