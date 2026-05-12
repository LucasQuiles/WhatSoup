/**
 * FleetSessionChart — pure render coverage for the recharts composed wrapper.
 * Tests traverse the returned React element tree (no jsdom, no DOM render).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetSessionChart } from '../../console/src/components/FleetSessionChart';
import type { SessionActivityBucket } from '../../console/src/types';

afterEach(() => {
  vi.restoreAllMocks();
});

function getProps(node: unknown): Record<string, unknown> {
  if (!node || typeof node !== 'object') return {};
  return (node as { props?: Record<string, unknown> }).props ?? {};
}

function toChildren(node: unknown): unknown[] {
  const children = getProps(node).children;
  if (children === undefined || children === null || children === false) return [];
  return Array.isArray(children) ? children.flat(Infinity) : [children];
}

function elementName(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const type = (node as { type?: { displayName?: string; name?: string } | string }).type;
  if (typeof type === 'string') return type;
  return type?.displayName ?? type?.name;
}

function findAll(node: unknown, name: string): unknown[] {
  const matches: unknown[] = [];
  function walk(n: unknown): void {
    if (!n || typeof n !== 'object') return;
    if (elementName(n) === name) matches.push(n);
    for (const child of toChildren(n)) walk(child);
  }
  walk(node);
  return matches;
}

function findOne(node: unknown, name: string): unknown {
  return findAll(node, name)[0];
}

/**
 * Recharts wrappers (ResponsiveContainer, ComposedChart) ship as memoized
 * components without displayName, so they read as anonymous in the rendered
 * element tree. We identify them positionally: the FleetSessionChart return
 * value is always ResponsiveContainer, and its single child is ComposedChart.
 */
function getResponsiveContainer(tree: unknown): unknown {
  return tree;
}

function getComposedChart(tree: unknown): unknown {
  return toChildren(tree)[0];
}

const SINGLE_DATA: SessionActivityBucket[] = [
  { bucket: '2026-04-05T18:00:00.000Z', active: 3, started: 2 },
  { bucket: '2026-04-05T19:00:00.000Z', active: 5, started: 1 },
];

describe('FleetSessionChart — single-provider path', () => {
  it('wraps the chart in a 100%-sized responsive container and forwards input data unchanged', () => {
    const tree = FleetSessionChart({ data: SINGLE_DATA });

    expect(getProps(getResponsiveContainer(tree))).toMatchObject({ width: '100%', height: '100%' });

    const composed = getComposedChart(tree);
    // Data passed through unchanged when no multi-provider config
    expect(getProps(composed).data).toBe(SINGLE_DATA);
    expect(getProps(composed).margin).toMatchObject({ top: 4, right: 8, left: -12, bottom: 0 });
  });

  it('renders Area for active sessions and Bar for sessions started with success-color theming', () => {
    const tree = FleetSessionChart({ data: SINGLE_DATA, range: '7d' });

    const areas = findAll(tree, 'Area');
    const bars = findAll(tree, 'Bar');
    expect(areas).toHaveLength(1);
    expect(bars).toHaveLength(1);

    expect(getProps(areas[0])).toMatchObject({
      type: 'monotone',
      dataKey: 'active',
      name: 'Active Sessions',
      stroke: 'var(--color-s-ok)',
      fill: 'var(--color-s-ok)',
    });
    expect(getProps(bars[0])).toMatchObject({
      dataKey: 'started',
      name: 'Sessions Started',
      fill: 'var(--color-s-ok)',
      barSize: 4,
    });
  });

  it('configures XAxis on bucket and YAxis with no-decimal compact formatting; tickFormatters wire range through', () => {
    const tree = FleetSessionChart({ data: SINGLE_DATA, range: '30d' });

    const xAxis = findOne(tree, 'XAxis');
    const yAxis = findOne(tree, 'YAxis');
    expect(getProps(xAxis)).toMatchObject({ dataKey: 'bucket', minTickGap: 40, tickLine: false });
    expect(getProps(yAxis)).toMatchObject({ width: 32, allowDecimals: false, tickLine: false, axisLine: false });

    // YAxis tick formatter — formatCompact treats non-numeric input as 0
    const yFormatter = getProps(yAxis).tickFormatter as (v: unknown) => string;
    expect(yFormatter(0)).toBe('0');
    expect(yFormatter('garbage')).toBe('0');
    expect(yFormatter(1500)).toMatch(/1\.5K|1,500|1500/);

    // XAxis tick formatter exists and returns a string when given a bucket
    const xFormatter = getProps(xAxis).tickFormatter as (v: string) => string;
    expect(typeof xFormatter('2026-04-05T18:00:00.000Z')).toBe('string');

    // Tooltip labelFormatter is wired through; returns a string for any bucket label
    const tooltip = findOne(tree, 'Tooltip');
    const labelFormatter = getProps(tooltip).labelFormatter as (v: string) => string;
    expect(typeof labelFormatter('2026-04-05T18:00:00.000Z')).toBe('string');
  });

  it('falls back to single-provider rendering when only one provider is supplied', () => {
    const tree = FleetSessionChart({
      data: SINGLE_DATA,
      providers: ['claude-cli'],
      byProvider: { 'claude-cli': SINGLE_DATA },
    });

    const composed = getComposedChart(tree);
    // Single path identifies by data === SINGLE_DATA (not merged)
    expect(getProps(composed).data).toBe(SINGLE_DATA);
    expect(findAll(tree, 'Area')).toHaveLength(1);
    expect(findAll(tree, 'Bar')).toHaveLength(1);
    // No legend in single path
    expect(findOne(tree, 'Legend')).toBeUndefined();
  });

  it('falls back to single-provider rendering when byProvider is omitted even if providers has multiple entries', () => {
    const tree = FleetSessionChart({
      data: SINGLE_DATA,
      providers: ['claude-cli', 'codex-cli'],
    });

    expect(findAll(tree, 'Area')).toHaveLength(1);
    expect(findAll(tree, 'Bar')).toHaveLength(1);
    expect(findOne(tree, 'Legend')).toBeUndefined();
  });

  it('passes empty data through without crashing', () => {
    const tree = FleetSessionChart({ data: [] });

    const composed = getComposedChart(tree);
    expect(getProps(composed).data).toEqual([]);
    expect(findAll(tree, 'Area')).toHaveLength(1);
    expect(findAll(tree, 'Bar')).toHaveLength(1);
  });
});

describe('FleetSessionChart — multi-provider path', () => {
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

  it('merges per-provider buckets into one row per timestamp with per-provider active/started keys', () => {
    const tree = FleetSessionChart({ data: SINGLE_DATA, providers, byProvider });

    const composed = getComposedChart(tree);
    const merged = getProps(composed).data as Record<string, unknown>[];
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({
      bucket: '2026-04-05T18:00:00.000Z',
      'claude-cli:active': 3,
      'claude-cli:started': 2,
      'codex-cli:active': 7,
      'codex-cli:started': 5,
    });
    expect(merged[1]).toEqual({
      bucket: '2026-04-05T19:00:00.000Z',
      'claude-cli:active': 4,
      'claude-cli:started': 1,
      'codex-cli:active': 2,
      'codex-cli:started': 0,
    });
  });

  it('emits one Area + one Bar per provider with provider-specific dataKeys, stack ids, and a Legend', () => {
    const tree = FleetSessionChart({ data: SINGLE_DATA, providers, byProvider });

    const areas = findAll(tree, 'Area');
    const bars = findAll(tree, 'Bar');
    expect(areas).toHaveLength(2);
    expect(bars).toHaveLength(2);
    expect(findOne(tree, 'Legend')).toBeTruthy();

    const areaKeys = areas.map((a) => getProps(a).dataKey);
    const barKeys = bars.map((b) => getProps(b).dataKey);
    expect(areaKeys).toEqual(['claude-cli:active', 'codex-cli:active']);
    expect(barKeys).toEqual(['claude-cli:started', 'codex-cli:started']);

    // Shared stack ids so series stack within their own category
    expect(areas.every((a) => getProps(a).stackId === 'active')).toBe(true);
    expect(bars.every((b) => getProps(b).stackId === 'started')).toBe(true);
  });

  it('labels series using the provider shortName when known and the raw id when unknown', () => {
    const tree = FleetSessionChart({
      data: SINGLE_DATA,
      providers: ['claude-cli', 'bogus-provider'],
      byProvider: { ...byProvider, 'bogus-provider': SINGLE_DATA },
    });

    const areas = findAll(tree, 'Area');
    expect(getProps(areas[0]).name).toBe('Claude Active');
    expect(getProps(areas[1]).name).toBe('bogus-provider Active');
  });

  it('fills missing per-provider buckets with zero so misaligned series do not propagate NaN', () => {
    const sparse: Record<string, SessionActivityBucket[]> = {
      'claude-cli': [{ bucket: '2026-04-05T18:00:00.000Z', active: 1, started: 1 }],
      'codex-cli': [], // entirely empty
    };
    const tree = FleetSessionChart({
      data: [
        { bucket: '2026-04-05T18:00:00.000Z', active: 0, started: 0 },
        { bucket: '2026-04-05T19:00:00.000Z', active: 0, started: 0 },
      ],
      providers,
      byProvider: sparse,
    });

    const merged = getProps(getComposedChart(tree)).data as Record<string, number | string>[];
    expect(merged[0]['claude-cli:active']).toBe(1);
    expect(merged[0]['codex-cli:active']).toBe(0);
    expect(merged[1]['claude-cli:active']).toBe(0);
    expect(merged[1]['codex-cli:started']).toBe(0);
  });
});
