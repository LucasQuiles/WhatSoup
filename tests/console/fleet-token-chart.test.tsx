/**
 * FleetTokenChart — rendered behavior through a semantic Recharts boundary.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { TokenUsageBucket, MetricsRange } from '../../console/src/types.js';
import { FleetTokenChart } from '../../console/src/components/FleetTokenChart';

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
        <section aria-label="Fleet token usage chart" role="region">
          {children}
        </section>
      );
    },
    AreaChart({ data = [], children }: { data?: ChartDatum[]; children?: React.ReactNode }) {
      return (
        <ChartDataContext.Provider value={data}>
          <div aria-label="Stacked token usage" role="group">
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
    YAxis({ tickFormatter }: { tickFormatter?: Formatter }) {
      return (
        <div aria-label="Token count axis" role="group">
          {tickFormatter ? tickFormatter(1000) : 'Tokens'}
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
      name,
      stroke,
      fill,
    }: {
      dataKey?: string;
      name?: string;
      stroke?: string;
      fill?: string;
    }) {
      const data = React.useContext(ChartDataContext);
      const seriesName = name ?? dataKey ?? 'Series';
      return (
        <section aria-label={`${seriesName} series`} data-fill={fill} data-stroke={stroke} role="region">
          <h3>{seriesName}</h3>
          <ul aria-label={`${seriesName} data points`}>
            {data.map((datum) => (
              <li key={`${seriesName}-${datum.bucket}`}>
                {seriesName}: {String(datum.bucket)} - {String(datum[dataKey ?? ''])} tokens
              </li>
            ))}
          </ul>
        </section>
      );
    },
  };
});

afterEach(() => cleanup());

const SAMPLE: TokenUsageBucket[] = [
  { bucket: '2026-04-05T18:00:00.000Z', input: 1200, output: 800 },
  { bucket: '2026-04-05T19:00:00.000Z', input: 1500, output: 600 },
];

function chart() {
  return screen.getByRole('region', { name: 'Fleet token usage chart' });
}

function series(name: string) {
  return within(chart()).getByRole('region', { name: `${name} series` });
}

describe('FleetTokenChart single-provider rendering', () => {
  it('renders the chart frame, axes, tooltip label, and stacked token series', () => {
    render(<FleetTokenChart data={SAMPLE} />);

    expect(chart()).toBeDefined();
    expect(within(chart()).getByRole('group', { name: 'Stacked token usage' })).toBeDefined();
    expect(within(chart()).getByRole('group', { name: 'Time axis' })).toBeDefined();
    expect(within(chart()).getByRole('group', { name: 'Token count axis' })).toBeDefined();
    // single-provider has no legend
    expect(within(chart()).queryByRole('group', { name: 'Chart legend' })).toBeNull();

    const activeLabel = within(chart()).getByLabelText('Active bucket label').textContent;
    expect(activeLabel).toBeTruthy();
    // should not be raw ISO bucket — formatter should transform it
    expect(activeLabel).not.toBe('2026-04-05T18:00:00.000Z');
  });

  it('renders output and input token series with correct values', () => {
    render(<FleetTokenChart data={SAMPLE} />);

    expect(within(series('Output Tokens')).getByRole('heading', { name: 'Output Tokens' })).toBeDefined();
    expect(within(series('Input Tokens')).getByRole('heading', { name: 'Input Tokens' })).toBeDefined();

    expect(within(series('Output Tokens')).getByText(/Output Tokens: 2026-04-05T18:00:00.000Z - 800 tokens/)).toBeDefined();
    expect(within(series('Output Tokens')).getByText(/Output Tokens: 2026-04-05T19:00:00.000Z - 600 tokens/)).toBeDefined();
    expect(within(series('Input Tokens')).getByText(/Input Tokens: 2026-04-05T18:00:00.000Z - 1200 tokens/)).toBeDefined();
    expect(within(series('Input Tokens')).getByText(/Input Tokens: 2026-04-05T19:00:00.000Z - 1500 tokens/)).toBeDefined();

    expect(series('Output Tokens').dataset.stroke).toBe('var(--data-token-output-solid)');
    expect(series('Output Tokens').dataset.fill).toBe('var(--data-token-output-solid)');
    expect(series('Input Tokens').dataset.stroke).toBe('var(--data-token-input-solid)');
    expect(series('Input Tokens').dataset.fill).toBe('var(--data-token-input-solid)');
  });

  it('uses range-aware labels for the visible time axis and active tooltip bucket', () => {
    const { rerender } = render(<FleetTokenChart data={SAMPLE} />);

    const defaultAxis = within(chart()).getByRole('group', { name: 'Time axis' }).textContent;
    const defaultTooltip = within(chart()).getByLabelText('Active bucket label').textContent;

    rerender(<FleetTokenChart data={SAMPLE} range="7d" />);
    const weeklyAxis = within(chart()).getByRole('group', { name: 'Time axis' }).textContent;
    const weeklyTooltip = within(chart()).getByLabelText('Active bucket label').textContent;

    rerender(<FleetTokenChart data={SAMPLE} range="30d" />);
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

  it('renders compact-formatted y-axis tick values', () => {
    render(<FleetTokenChart data={SAMPLE} />);

    // YAxis tickFormatter applies formatCompact; 1000 → "1.0K" (toFixed(1) for values < 10_000)
    const axisText = within(chart()).getByRole('group', { name: 'Token count axis' }).textContent;
    expect(axisText).toBe('1.0K');
  });

  it('keeps the chart semantics and series labels when there are no token buckets', () => {
    render(<FleetTokenChart data={[]} range="30d" />);

    expect(chart()).toBeDefined();
    expect(within(chart()).getByRole('group', { name: 'Time axis' })).toBeDefined();
    expect(within(chart()).queryByLabelText('Active bucket label')).toBeNull();

    for (const name of ['Output Tokens', 'Input Tokens']) {
      expect(within(series(name)).getByRole('heading', { name })).toBeDefined();
      expect(within(series(name)).queryAllByRole('listitem')).toHaveLength(0);
    }

    // single-provider still has no legend even when empty
    expect(within(chart()).queryByRole('group', { name: 'Chart legend' })).toBeNull();
  });

  it('stays in single-provider mode when only one provider is supplied', () => {
    render(
      <FleetTokenChart
        data={SAMPLE}
        providers={['claude-cli']}
        byProvider={{ 'claude-cli': SAMPLE }}
      />,
    );

    expect(within(series('Output Tokens')).getByRole('heading', { name: 'Output Tokens' })).toBeDefined();
    expect(within(series('Input Tokens')).getByRole('heading', { name: 'Input Tokens' })).toBeDefined();
    expect(within(chart()).queryByRole('group', { name: 'Chart legend' })).toBeNull();
    // no provider-prefixed series expected in single-provider mode
    expect(within(chart()).queryByRole('region', { name: /Claude Out series/ })).toBeNull();
  });

  it('stays in single-provider mode when providers are listed but byProvider is absent', () => {
    render(
      <FleetTokenChart
        data={SAMPLE}
        providers={['claude-cli', 'codex-cli']}
      />,
    );

    expect(within(series('Output Tokens')).getByRole('heading', { name: 'Output Tokens' })).toBeDefined();
    expect(within(series('Input Tokens')).getByRole('heading', { name: 'Input Tokens' })).toBeDefined();
    expect(within(chart()).queryByRole('group', { name: 'Chart legend' })).toBeNull();
  });
});

describe('FleetTokenChart multi-provider rendering', () => {
  const providers = ['claude-cli', 'codex-cli'];

  const byProvider: Record<string, TokenUsageBucket[]> = {
    'claude-cli': [
      { bucket: '2026-04-05T18:00:00.000Z', input: 1200, output: 800 },
      { bucket: '2026-04-05T19:00:00.000Z', input: 1500, output: 600 },
    ],
    'codex-cli': [
      { bucket: '2026-04-05T18:00:00.000Z', input: 400, output: 200 },
      { bucket: '2026-04-05T19:00:00.000Z', input: 600, output: 300 },
    ],
  };

  it('shows a legend and one output and input series per provider', () => {
    render(<FleetTokenChart data={SAMPLE} providers={providers} byProvider={byProvider} />);

    expect(within(chart()).getByRole('group', { name: 'Chart legend' })).toBeDefined();

    expect(within(series('Claude Out')).getByRole('heading', { name: 'Claude Out' })).toBeDefined();
    expect(within(series('Claude In')).getByRole('heading', { name: 'Claude In' })).toBeDefined();
    expect(within(series('CDX Out')).getByRole('heading', { name: 'CDX Out' })).toBeDefined();
    expect(within(series('CDX In')).getByRole('heading', { name: 'CDX In' })).toBeDefined();
  });

  it('maps provider bucket values into merged series rows correctly', () => {
    render(<FleetTokenChart data={SAMPLE} providers={providers} byProvider={byProvider} />);

    // claude-cli output series
    expect(
      within(series('Claude Out')).getByText(/Claude Out: 2026-04-05T18:00:00.000Z - 800 tokens/),
    ).toBeDefined();
    expect(
      within(series('Claude Out')).getByText(/Claude Out: 2026-04-05T19:00:00.000Z - 600 tokens/),
    ).toBeDefined();

    // claude-cli input series
    expect(
      within(series('Claude In')).getByText(/Claude In: 2026-04-05T18:00:00.000Z - 1200 tokens/),
    ).toBeDefined();

    // codex-cli output series
    expect(
      within(series('CDX Out')).getByText(/CDX Out: 2026-04-05T18:00:00.000Z - 200 tokens/),
    ).toBeDefined();

    // codex-cli input series
    expect(
      within(series('CDX In')).getByText(/CDX In: 2026-04-05T19:00:00.000Z - 600 tokens/),
    ).toBeDefined();
  });

  it('uses raw provider id as label when provider is not in the registry', () => {
    render(
      <FleetTokenChart
        data={SAMPLE}
        providers={['claude-cli', 'bogus-provider']}
        byProvider={{ ...byProvider, 'bogus-provider': SAMPLE }}
      />,
    );

    expect(within(series('Claude Out')).getByRole('heading', { name: 'Claude Out' })).toBeDefined();
    expect(within(series('bogus-provider Out')).getByRole('heading', { name: 'bogus-provider Out' })).toBeDefined();
    expect(within(series('bogus-provider In')).getByRole('heading', { name: 'bogus-provider In' })).toBeDefined();
  });

  it('fills missing provider buckets with zero values', () => {
    render(
      <FleetTokenChart
        data={[
          { bucket: '2026-04-05T18:00:00.000Z', input: 0, output: 0 },
          { bucket: '2026-04-05T19:00:00.000Z', input: 0, output: 0 },
        ]}
        providers={providers}
        byProvider={{
          'claude-cli': [{ bucket: '2026-04-05T18:00:00.000Z', input: 100, output: 50 }],
          'codex-cli': [],
        }}
      />,
    );

    // claude-cli first bucket present
    expect(
      within(series('Claude Out')).getByText(/Claude Out: 2026-04-05T18:00:00.000Z - 50 tokens/),
    ).toBeDefined();
    // claude-cli second bucket absent from byProvider — falls back to 0
    expect(
      within(series('Claude Out')).getByText(/Claude Out: 2026-04-05T19:00:00.000Z - 0 tokens/),
    ).toBeDefined();
    // codex-cli is entirely empty — all zeros
    expect(
      within(series('CDX Out')).getByText(/CDX Out: 2026-04-05T18:00:00.000Z - 0 tokens/),
    ).toBeDefined();
    expect(
      within(series('CDX In')).getByText(/CDX In: 2026-04-05T19:00:00.000Z - 0 tokens/),
    ).toBeDefined();
  });

  it('renders the multi-provider chart with an empty data array without throwing', () => {
    render(
      <FleetTokenChart data={[]} providers={providers} byProvider={byProvider} />,
    );

    expect(within(chart()).queryByLabelText('Active bucket label')).toBeNull();
    expect(within(chart()).getByRole('group', { name: 'Chart legend' })).toBeDefined();

    for (const name of ['Claude Out', 'Claude In', 'CDX Out', 'CDX In']) {
      expect(within(series(name)).queryAllByRole('listitem')).toHaveLength(0);
    }
  });
});
