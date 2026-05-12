/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { FleetSessionChart } from '../../console/src/components/FleetSessionChart';
import type { SessionActivityBucket } from '../../console/src/types';

vi.mock('recharts', async () => {
  const React = await vi.importActual<typeof import('react')>('react');

  type ChartRow = Record<string, string | number | null | undefined>;

  const ChartDataContext = React.createContext<ChartRow[]>([]);

  function readNumber(row: ChartRow, dataKey: string): number {
    const value = row[dataKey];
    return typeof value === 'number' ? value : 0;
  }

  function renderSeries(name: string, dataKey: string, kind: string) {
    const rows = React.useContext(ChartDataContext);

    return (
      <section role="group" aria-label={name} data-chart-kind={kind}>
        <h2>{name}</h2>
        {rows.length === 0 ? (
          <p>No values</p>
        ) : (
          <ul>
            {rows.map((row) => (
              <li key={`${row.bucket}:${dataKey}`}>
                {String(row.bucket)}: {readNumber(row, dataKey)}
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  return {
    ResponsiveContainer({
      children,
      width,
      height,
    }: {
      children: ReactNode;
      width: string | number;
      height: string | number;
    }) {
      return (
        <div aria-label="Responsive chart region" style={{ width: String(width), height: String(height) }}>
          {children}
        </div>
      );
    },
    ComposedChart({ children, data }: { children: ReactNode; data: ChartRow[] }) {
      return (
        <div role="img" aria-label="Fleet session activity chart">
          <ChartDataContext.Provider value={data}>{children}</ChartDataContext.Provider>
        </div>
      );
    },
    CartesianGrid() {
      return null;
    },
    XAxis({
      dataKey,
      tickFormatter,
    }: {
      dataKey: string;
      tickFormatter?: (value: string) => string;
    }) {
      const rows = React.useContext(ChartDataContext);
      return (
        <div aria-label="Time axis">
          {rows.map((row) => {
            const raw = String(row[dataKey]);
            return <span key={raw}>{tickFormatter ? tickFormatter(raw) : raw}</span>;
          })}
        </div>
      );
    },
    YAxis({
      tickFormatter,
    }: {
      tickFormatter?: (value: number) => string;
    }) {
      const rows = React.useContext(ChartDataContext);
      const values = rows.flatMap((row) =>
        Object.entries(row)
          .filter(([key, value]) => key !== 'bucket' && typeof value === 'number')
          .map(([, value]) => value as number),
      );

      return (
        <div aria-label="Session count axis">
          {[...new Set(values)].map((value) => (
            <span key={value}>{tickFormatter ? tickFormatter(value) : String(value)}</span>
          ))}
        </div>
      );
    },
    Tooltip({ labelFormatter }: { labelFormatter?: (value: string) => string }) {
      const rows = React.useContext(ChartDataContext);
      const firstBucket = rows[0]?.bucket;
      if (firstBucket === undefined) return null;
      const label = String(firstBucket);
      return <div aria-label="Chart tooltip label">{labelFormatter ? labelFormatter(label) : label}</div>;
    },
    Legend() {
      return <div aria-label="Chart legend">Chart legend</div>;
    },
    Area({ dataKey, name }: { dataKey: string; name: string }) {
      return renderSeries(name, dataKey, 'area');
    },
    Bar({ dataKey, name }: { dataKey: string; name: string }) {
      return renderSeries(name, dataKey, 'bar');
    },
  };
});

afterEach(() => cleanup());

const SINGLE_DATA: SessionActivityBucket[] = [
  { bucket: '2026-04-05T18:00:00.000Z', active: 3, started: 2 },
  { bucket: '2026-04-05T19:00:00.000Z', active: 5, started: 1 },
];

function renderChart(props: Parameters<typeof FleetSessionChart>[0]) {
  return render(<FleetSessionChart {...props} />);
}

function series(name: string): HTMLElement {
  return screen.getByRole('group', { name });
}

describe('FleetSessionChart single-provider rendering', () => {
  it('renders a labeled chart, formatted axes, and the two session series', () => {
    renderChart({ data: SINGLE_DATA, range: '30d' });

    expect(screen.getByRole('img', { name: 'Fleet session activity chart' })).toBeDefined();
    const chartRegion = screen.getByLabelText('Responsive chart region') as HTMLElement;
    expect(chartRegion.style.width).toBe('100%');
    expect(chartRegion.style.height).toBe('100%');
    expect(screen.getByLabelText('Time axis').textContent).toContain('Apr 5');
    expect(screen.getByLabelText('Chart tooltip label').textContent).toContain('Apr 5');
    expect(screen.queryByLabelText('Chart legend')).toBeNull();

    const active = series('Active Sessions');
    expect(within(active).getByText('2026-04-05T18:00:00.000Z: 3')).toBeDefined();
    expect(within(active).getByText('2026-04-05T19:00:00.000Z: 5')).toBeDefined();

    const started = series('Sessions Started');
    expect(within(started).getByText('2026-04-05T18:00:00.000Z: 2')).toBeDefined();
    expect(within(started).getByText('2026-04-05T19:00:00.000Z: 1')).toBeDefined();
  });

  it('keeps the single-provider view when one provider is supplied or provider data is missing', () => {
    const { rerender } = renderChart({
      data: SINGLE_DATA,
      providers: ['claude-cli'],
      byProvider: { 'claude-cli': SINGLE_DATA },
    });

    expect(series('Active Sessions')).toBeDefined();
    expect(screen.queryByRole('group', { name: 'Claude Active' })).toBeNull();
    expect(screen.queryByLabelText('Chart legend')).toBeNull();

    rerender(<FleetSessionChart data={SINGLE_DATA} providers={['claude-cli', 'codex-cli']} />);

    expect(series('Active Sessions')).toBeDefined();
    expect(series('Sessions Started')).toBeDefined();
    expect(screen.queryByRole('group', { name: 'Claude Active' })).toBeNull();
    expect(screen.queryByLabelText('Chart legend')).toBeNull();
  });

  it('renders empty single-provider data without throwing', () => {
    renderChart({ data: [] });

    expect(within(series('Active Sessions')).getByText('No values')).toBeDefined();
    expect(within(series('Sessions Started')).getByText('No values')).toBeDefined();
  });
});

describe('FleetSessionChart multi-provider rendering', () => {
  const providers = ['claude-cli', 'codex-cli'];
  const byProvider: Record<string, SessionActivityBucket[]> = {
    'claude-cli': [
      { bucket: '2026-04-05T18:00:00.000Z', active: 3, started: 2 },
      { bucket: '2026-04-05T19:00:00.000Z', active: 4, started: 1 },
    ],
    'codex-cli': [
      { bucket: '2026-04-05T18:00:00.000Z', active: 7, started: 5 },
      { bucket: '2026-04-05T19:00:00.000Z', active: 2, started: 0 },
    ],
  };

  it('renders a legend and one active and started series per provider', () => {
    renderChart({ data: SINGLE_DATA, providers, byProvider });

    expect(screen.getByLabelText('Chart legend')).toBeDefined();

    expect(within(series('Claude Active')).getByText('2026-04-05T18:00:00.000Z: 3')).toBeDefined();
    expect(within(series('Claude Active')).getByText('2026-04-05T19:00:00.000Z: 4')).toBeDefined();
    expect(within(series('Claude Started')).getByText('2026-04-05T18:00:00.000Z: 2')).toBeDefined();
    expect(within(series('CDX Active')).getByText('2026-04-05T18:00:00.000Z: 7')).toBeDefined();
    expect(within(series('CDX Started')).getByText('2026-04-05T18:00:00.000Z: 5')).toBeDefined();
    expect(within(series('CDX Started')).getByText('2026-04-05T19:00:00.000Z: 0')).toBeDefined();
  });

  it('uses raw provider ids as labels when a provider is unknown', () => {
    renderChart({
      data: SINGLE_DATA,
      providers: ['claude-cli', 'bogus-provider'],
      byProvider: { ...byProvider, 'bogus-provider': SINGLE_DATA },
    });

    expect(series('Claude Active')).toBeDefined();
    expect(series('bogus-provider Active')).toBeDefined();
    expect(series('bogus-provider Started')).toBeDefined();
  });

  it('fills missing provider buckets with zero values', () => {
    renderChart({
      data: [
        { bucket: '2026-04-05T18:00:00.000Z', active: 0, started: 0 },
        { bucket: '2026-04-05T19:00:00.000Z', active: 0, started: 0 },
      ],
      providers,
      byProvider: {
        'claude-cli': [{ bucket: '2026-04-05T18:00:00.000Z', active: 1, started: 1 }],
        'codex-cli': [],
      },
    });

    expect(within(series('Claude Active')).getByText('2026-04-05T18:00:00.000Z: 1')).toBeDefined();
    expect(within(series('Claude Active')).getByText('2026-04-05T19:00:00.000Z: 0')).toBeDefined();
    expect(within(series('CDX Active')).getByText('2026-04-05T18:00:00.000Z: 0')).toBeDefined();
    expect(within(series('CDX Started')).getByText('2026-04-05T19:00:00.000Z: 0')).toBeDefined();
  });
});
