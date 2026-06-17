/**
 * FleetTokenChart — rendered behavior through a semantic Recharts boundary.
 *
 * The token-spend panel is a provider-palette DONUT (ring): one segment per
 * provider sized by total token spend in multi-provider mode, and an input-vs-output
 * ring in the single-provider fallback. The recharts mock below surfaces the Pie
 * segments, their fills, the legend, the tooltip, and the center total so the tests
 * can assert the donut's behaviour without a real SVG renderer.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { TokenUsageBucket } from '../../console/src/types.js';
import { FleetTokenChart } from '../../console/src/components/FleetTokenChart';

vi.mock('recharts', async () => {
  const React = await import('react');

  type Segment = { key?: string; name: string; value: number; fill: string };
  type PieChild = React.ReactElement<{ fill?: string }>;

  return {
    ResponsiveContainer({ children }: { children?: React.ReactNode }) {
      return (
        <section aria-label="Fleet token usage chart" role="region">
          {children}
        </section>
      );
    },
    PieChart({ children }: { children?: React.ReactNode }) {
      return (
        <div aria-label="Token spend donut" role="group">
          {children}
        </div>
      );
    },
    Pie({
      data = [],
      children,
    }: {
      data?: Segment[];
      dataKey?: string;
      nameKey?: string;
      innerRadius?: number | string;
      outerRadius?: number | string;
      children?: React.ReactNode;
    }) {
      // <Cell> children carry the per-segment fill, positionally matched to data.
      const cells = React.Children.toArray(children) as PieChild[];
      return (
        <div aria-label="Donut ring" role="group">
          {data.map((segment, index) => {
            const cellFill = cells[index]?.props?.fill ?? segment.fill;
            return (
              <section
                key={segment.key ?? segment.name}
                aria-label={`${segment.name} segment`}
                data-fill={cellFill}
                data-value={segment.value}
                role="region"
              >
                <h3>{segment.name}</h3>
                <span>{segment.value} tokens</span>
              </section>
            );
          })}
        </div>
      );
    },
    Cell() {
      // Rendered structurally via Pie's children; nothing to emit standalone.
      return null;
    },
    Tooltip() {
      return <output aria-label="Segment tooltip" />;
    },
    Legend() {
      return (
        <div aria-label="Chart legend" role="group">
          Legend
        </div>
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

function segment(name: string) {
  return within(chart()).getByRole('region', { name: `${name} segment` });
}

describe('FleetTokenChart single-provider fallback', () => {
  it('renders an input-vs-output donut with no legend', () => {
    render(<FleetTokenChart data={SAMPLE} />);

    expect(chart()).toBeDefined();
    expect(within(chart()).getByRole('group', { name: 'Token spend donut' })).toBeDefined();
    expect(within(chart()).getByRole('group', { name: 'Donut ring' })).toBeDefined();
    // single-provider has no legend
    expect(within(chart()).queryByRole('group', { name: 'Chart legend' })).toBeNull();

    expect(within(segment('Output Tokens')).getByRole('heading', { name: 'Output Tokens' })).toBeDefined();
    expect(within(segment('Input Tokens')).getByRole('heading', { name: 'Input Tokens' })).toBeDefined();
  });

  it('aggregates input and output totals across all buckets', () => {
    render(<FleetTokenChart data={SAMPLE} />);

    // output: 800 + 600 = 1400; input: 1200 + 1500 = 2700
    expect(segment('Output Tokens').dataset.value).toBe('1400');
    expect(segment('Input Tokens').dataset.value).toBe('2700');
  });

  it('colors the fallback segments with the sanctioned data-series token palette', () => {
    render(<FleetTokenChart data={SAMPLE} />);

    expect(segment('Output Tokens').dataset.fill).toBe('var(--data-token-output-solid)');
    expect(segment('Input Tokens').dataset.fill).toBe('var(--data-token-input-solid)');
  });

  it('shows the center total of all tokens', () => {
    render(<FleetTokenChart data={SAMPLE} />);

    // grand total 1400 + 2700 = 4100 → formatCompact → "4.1K"
    expect(within(chart()).getByLabelText('Total tokens').textContent).toContain('4.1K');
    expect(within(chart()).getByLabelText('Total tokens').textContent).toContain('TOKENS');
  });

  it('preserves the chart frame and a zero total when there are no token buckets', () => {
    render(<FleetTokenChart data={[]} range="30d" />);

    expect(chart()).toBeDefined();
    expect(within(chart()).getByRole('group', { name: 'Donut ring' })).toBeDefined();
    expect(segment('Output Tokens').dataset.value).toBe('0');
    expect(segment('Input Tokens').dataset.value).toBe('0');
    expect(within(chart()).getByLabelText('Total tokens').textContent).toContain('0');
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

    expect(within(segment('Output Tokens')).getByRole('heading', { name: 'Output Tokens' })).toBeDefined();
    expect(within(segment('Input Tokens')).getByRole('heading', { name: 'Input Tokens' })).toBeDefined();
    expect(within(chart()).queryByRole('group', { name: 'Chart legend' })).toBeNull();
    // no provider-named segment expected in single-provider mode
    expect(within(chart()).queryByRole('region', { name: /Claude segment/ })).toBeNull();
  });

  it('stays in single-provider mode when providers are listed but byProvider is absent', () => {
    render(<FleetTokenChart data={SAMPLE} providers={['claude-cli', 'codex-cli']} />);

    expect(within(segment('Output Tokens')).getByRole('heading', { name: 'Output Tokens' })).toBeDefined();
    expect(within(segment('Input Tokens')).getByRole('heading', { name: 'Input Tokens' })).toBeDefined();
    expect(within(chart()).queryByRole('group', { name: 'Chart legend' })).toBeNull();
  });
});

describe('FleetTokenChart multi-provider donut', () => {
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

  it('shows a legend and one ring segment per provider', () => {
    render(<FleetTokenChart data={SAMPLE} providers={providers} byProvider={byProvider} />);

    expect(within(chart()).getByRole('group', { name: 'Chart legend' })).toBeDefined();
    expect(within(segment('Claude')).getByRole('heading', { name: 'Claude' })).toBeDefined();
    expect(within(segment('CDX')).getByRole('heading', { name: 'CDX' })).toBeDefined();
  });

  it('sizes each provider segment by total token spend (input + output across buckets)', () => {
    render(<FleetTokenChart data={SAMPLE} providers={providers} byProvider={byProvider} />);

    // claude: (1200+800) + (1500+600) = 4100
    expect(segment('Claude').dataset.value).toBe('4100');
    // codex: (400+200) + (600+300) = 1500
    expect(segment('CDX').dataset.value).toBe('1500');
  });

  it('colors each provider segment from the locked provider palette', () => {
    render(<FleetTokenChart data={SAMPLE} providers={providers} byProvider={byProvider} />);

    // provider colors live in the --provider-* namespace
    expect(segment('Claude').dataset.fill).toBe('var(--provider-claude-fg)');
    expect(segment('CDX').dataset.fill).toBe('var(--provider-codex-fg)');
  });

  it('shows the center total across all providers', () => {
    render(<FleetTokenChart data={SAMPLE} providers={providers} byProvider={byProvider} />);

    // 4100 + 1500 = 5600 → "5.6K"
    expect(within(chart()).getByLabelText('Total tokens').textContent).toContain('5.6K');
  });

  it('uses the raw provider id as label when the provider is not in the registry', () => {
    render(
      <FleetTokenChart
        data={SAMPLE}
        providers={['claude-cli', 'bogus-provider']}
        byProvider={{ ...byProvider, 'bogus-provider': SAMPLE }}
      />,
    );

    expect(within(segment('Claude')).getByRole('heading', { name: 'Claude' })).toBeDefined();
    expect(within(segment('bogus-provider')).getByRole('heading', { name: 'bogus-provider' })).toBeDefined();
    // unknown provider falls back to the unknown-provider palette token
    expect(segment('bogus-provider').dataset.fill).toBe('var(--text-3)');
  });

  it('renders the multi-provider donut with empty per-provider data as zero segments', () => {
    render(
      <FleetTokenChart
        data={[]}
        providers={providers}
        byProvider={{ 'claude-cli': [], 'codex-cli': [] }}
      />,
    );

    expect(within(chart()).getByRole('group', { name: 'Chart legend' })).toBeDefined();
    expect(segment('Claude').dataset.value).toBe('0');
    expect(segment('CDX').dataset.value).toBe('0');
    expect(within(chart()).getByLabelText('Total tokens').textContent).toContain('0');
  });
});
