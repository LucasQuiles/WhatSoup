/**
 * MetricsChart - rendered behavior through a semantic Recharts boundary.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { MessageVolumeBucket } from '../../console/src/types.js';
import { MetricsChart } from '../../console/src/components/MetricsChart';

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
        <section aria-label="Line message volume chart" role="region">
          {children}
        </section>
      );
    },
    BarChart({ data = [], children }: { data?: ChartDatum[]; children?: React.ReactNode }) {
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
    Bar({ dataKey, fill, name }: { dataKey?: string; fill?: string; name?: string }) {
      const data = React.useContext(ChartDataContext);
      const seriesName = name ?? dataKey ?? 'Series';

      return (
        <section aria-label={`${seriesName} series`} data-fill={fill} role="region">
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
  return screen.getByRole('region', { name: 'Line message volume chart' });
}

function series(name: string) {
  return within(chart()).getByRole('region', { name: `${name} series` });
}

describe('MetricsChart', () => {
  it('renders the chart frame, axes, tooltip label, legend, and stacked message series', () => {
    render(<MetricsChart data={SAMPLE} />);

    expect(chart()).toBeDefined();
    expect(within(chart()).getByRole('group', { name: 'Stacked message volume' })).toBeDefined();
    expect(within(chart()).getByRole('group', { name: 'Time axis' })).toBeDefined();
    expect(within(chart()).getByRole('group', { name: 'Message count axis' })).toBeDefined();
    expect(within(chart()).getByRole('group', { name: 'Chart legend' })).toBeDefined();
    expect(within(chart()).getByLabelText('Active bucket label').textContent).not.toContain('2026-04-05T18:00:00.000Z');

    expect(within(series('Inbound')).getByRole('heading', { name: 'Inbound' })).toBeDefined();
    expect(within(series('Outbound')).getByRole('heading', { name: 'Outbound' })).toBeDefined();
    expect(within(series('Media')).getByRole('heading', { name: 'Media' })).toBeDefined();
  });

  it('uses the data-series token palette for aggregate message dimensions', () => {
    render(<MetricsChart data={SAMPLE} />);

    const expected = {
      Inbound: 'var(--data-inbound-solid)',
      Outbound: 'var(--data-outbound-solid)',
      Media: 'var(--data-media-solid)',
    };

    for (const [name, token] of Object.entries(expected)) {
      const region = series(name);
      expect(region.getAttribute('data-fill')).toBe(token);
      expect(region.getAttribute('data-fill')).not.toMatch(/--(?:color-[ms]-|provider-|status-|mode-)/);
    }
  });

  it('keeps the chart semantics and series labels when there are no message buckets', () => {
    render(<MetricsChart data={[]} range="30d" />);

    expect(chart()).toBeDefined();
    expect(within(chart()).getByRole('group', { name: 'Time axis' })).toBeDefined();
    expect(within(chart()).queryByLabelText('Active bucket label')).toBeNull();

    for (const name of ['Inbound', 'Outbound', 'Media']) {
      expect(within(series(name)).getByRole('heading', { name })).toBeDefined();
      expect(within(series(name)).queryAllByRole('listitem')).toHaveLength(0);
    }
  });
});
