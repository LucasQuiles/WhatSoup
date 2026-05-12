/** FleetMetricsChart — recharts wrapper structure regressions. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Recharts from 'recharts';
import type { MessageVolumeBucket } from '../../console/src/types.js';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

function getProps(node: unknown): Record<string, unknown> {
  if (!node || typeof node !== 'object') return {};
  return (node as { props?: Record<string, unknown> }).props ?? {};
}

function toChildren(node: unknown): unknown[] {
  if (!node || typeof node !== 'object') return [];
  const children = (node as { props?: { children?: unknown } }).props?.children;
  if (children === undefined || children === null) return [];
  return Array.isArray(children) ? children.flat(Infinity) : [children];
}

function findAllByType(node: unknown, type: unknown, acc: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return acc;
  if ((node as { type?: unknown }).type === type) acc.push(node);
  for (const child of toChildren(node)) findAllByType(child, type, acc);
  return acc;
}

function findFirstByType(node: unknown, type: unknown): unknown | undefined {
  return findAllByType(node, type)[0];
}

const SAMPLE: MessageVolumeBucket[] = [
  { bucket: '2026-04-05T18:00:00.000Z', inbound: 4, outbound: 2, media: 1 },
  { bucket: '2026-04-05T19:00:00.000Z', inbound: 6, outbound: 3, media: 0 },
];

describe('FleetMetricsChart', () => {
  it('wraps an AreaChart in ResponsiveContainer with full width/height', async () => {
    const { FleetMetricsChart } = await import('../../console/src/components/FleetMetricsChart.tsx');

    const element = FleetMetricsChart({ data: SAMPLE });

    expect((element as { type?: unknown }).type).toBe(Recharts.ResponsiveContainer);
    expect(getProps(element)).toMatchObject({ width: '100%', height: '100%' });

    const area = findFirstByType(element, Recharts.AreaChart);
    expect(area).toBeDefined();
    expect(getProps(area).data).toBe(SAMPLE);
  });

  it('passes data and CHART_MARGIN through to AreaChart', async () => {
    const { FleetMetricsChart } = await import('../../console/src/components/FleetMetricsChart.tsx');

    const element = FleetMetricsChart({ data: SAMPLE });
    const area = findFirstByType(element, Recharts.AreaChart);
    const props = getProps(area);

    expect(props.data).toBe(SAMPLE);
    expect(props.margin).toMatchObject({ top: 4, right: 8, left: -12, bottom: 0 });
  });

  it('renders three stacked Area series (inbound, outbound, media) sharing stackId', async () => {
    const { FleetMetricsChart } = await import('../../console/src/components/FleetMetricsChart.tsx');

    const element = FleetMetricsChart({ data: SAMPLE });
    const areas = findAllByType(element, Recharts.Area);

    expect(areas).toHaveLength(3);
    const dataKeys = areas.map((a) => getProps(a).dataKey);
    expect(dataKeys).toEqual(['inbound', 'outbound', 'media']);
    for (const a of areas) {
      expect(getProps(a)).toMatchObject({ stackId: 'msgs', type: 'monotone' });
    }
  });

  it('assigns distinct stroke/fill tokens and fillOpacity per series', async () => {
    const { FleetMetricsChart } = await import('../../console/src/components/FleetMetricsChart.tsx');

    const element = FleetMetricsChart({ data: SAMPLE });
    const [inbound, outbound, media] = findAllByType(element, Recharts.Area).map(getProps);

    expect(inbound).toMatchObject({
      name: 'Inbound',
      stroke: 'var(--color-m-pas)',
      fill: 'var(--color-m-pas)',
      fillOpacity: 0.3,
    });
    expect(outbound).toMatchObject({
      name: 'Outbound',
      stroke: 'var(--color-m-cht)',
      fill: 'var(--color-m-cht)',
      fillOpacity: 0.3,
    });
    expect(media).toMatchObject({
      name: 'Media',
      stroke: 'var(--color-s-warn)',
      fill: 'var(--color-s-warn)',
      fillOpacity: 0.2,
    });
  });

  it('renders CartesianGrid, axes, Tooltip, and Legend', async () => {
    const { FleetMetricsChart } = await import('../../console/src/components/FleetMetricsChart.tsx');

    const element = FleetMetricsChart({ data: SAMPLE });

    const grid = findFirstByType(element, Recharts.CartesianGrid);
    expect(grid).toBeDefined();
    expect(getProps(grid)).toMatchObject({ stroke: 'var(--b1)', vertical: false });

    const xAxis = findFirstByType(element, Recharts.XAxis);
    expect(getProps(xAxis)).toMatchObject({
      dataKey: 'bucket',
      tickLine: false,
      minTickGap: 40,
    });

    const yAxis = findFirstByType(element, Recharts.YAxis);
    expect(getProps(yAxis)).toMatchObject({
      tickLine: false,
      axisLine: false,
      width: 32,
      allowDecimals: false,
    });

    expect(findFirstByType(element, Recharts.Tooltip)).toBeDefined();
    expect(findFirstByType(element, Recharts.Legend)).toBeDefined();
  });

  it('formats X axis ticks using the supplied range', async () => {
    const { FleetMetricsChart } = await import('../../console/src/components/FleetMetricsChart.tsx');

    const element = FleetMetricsChart({ data: SAMPLE, range: '7d' });
    const xAxis = findFirstByType(element, Recharts.XAxis);
    const tickFormatter = getProps(xAxis).tickFormatter as (v: string) => string;

    expect(typeof tickFormatter).toBe('function');
    const out = tickFormatter('2026-04-06T12:00:00.000Z');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });

  it('routes tooltip label formatter through formatTooltipLabel for the active range', async () => {
    const { FleetMetricsChart } = await import('../../console/src/components/FleetMetricsChart.tsx');

    const element = FleetMetricsChart({ data: SAMPLE, range: '30d' });
    const tooltip = findFirstByType(element, Recharts.Tooltip);
    const labelFormatter = getProps(tooltip).labelFormatter as (v: unknown) => string;

    expect(typeof labelFormatter).toBe('function');
    const label = labelFormatter('2026-04-06T12:00:00.000Z');
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
  });

  it('accepts an empty data array without throwing and still wires the series', async () => {
    const { FleetMetricsChart } = await import('../../console/src/components/FleetMetricsChart.tsx');

    const element = FleetMetricsChart({ data: [] });
    const area = findFirstByType(element, Recharts.AreaChart);

    expect(getProps(area).data).toEqual([]);
    expect(findAllByType(element, Recharts.Area)).toHaveLength(3);
  });

  it('defaults range to 24h when omitted (tooltip formatter returns date+time fragments)', async () => {
    const { FleetMetricsChart } = await import('../../console/src/components/FleetMetricsChart.tsx');

    const element = FleetMetricsChart({ data: SAMPLE });
    const tooltip = findFirstByType(element, Recharts.Tooltip);
    const labelFormatter = getProps(tooltip).labelFormatter as (v: unknown) => string;

    const out = labelFormatter('2026-04-06T12:00:00.000Z');
    expect(typeof out).toBe('string');
    // 24h default includes both date and time fragments
    expect(out.length).toBeGreaterThan(4);
  });
});
