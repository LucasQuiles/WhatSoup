import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { SessionActivityBucket, MetricsRange } from '../types';
import { AXIS_TICK, CHART_MARGIN, TOOLTIP_STYLE, formatBucketLabel } from '../lib/chart-utils.js';
import { getProvider, getProviderColor } from '../lib/providers';

interface FleetSessionChartProps {
  data: SessionActivityBucket[];
  byProvider?: Record<string, SessionActivityBucket[]>;
  providers?: string[];
  range?: MetricsRange;
}

/** Composed chart with area (active sessions) + bar (sessions started). */
export function FleetSessionChart({ data, byProvider, providers, range = '24h' }: FleetSessionChartProps) {
  const multiProvider = providers && providers.length > 1 && byProvider;

  if (multiProvider) {
    const merged = data.map((bucket, i) => {
      const row: Record<string, unknown> = { bucket: bucket.bucket };
      for (const provider of providers) {
        const pb = byProvider[provider]?.[i];
        row[`${provider}:active`] = pb?.active ?? 0;
        row[`${provider}:started`] = pb?.started ?? 0;
      }
      return row;
    });

    return (
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={merged} margin={CHART_MARGIN}>
          <CartesianGrid stroke="var(--b1)" vertical={false} />
          <XAxis dataKey="bucket" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: 'var(--b1)' }} minTickGap={40} tickFormatter={(v) => formatBucketLabel(v, range)} />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={28} allowDecimals={false} />
          <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={(v) => new Date(String(v)).toLocaleString()} />
          <Legend wrapperStyle={{ fontSize: 'var(--font-size-xs)' }} />
          {providers.flatMap((provider) => {
            const color = getProviderColor(provider);
            const label = getProvider(provider)?.shortName ?? provider;
            return [
              <Area key={`${provider}:active`} type="monotone" dataKey={`${provider}:active`} name={`${label} Active`} stackId="active" stroke={color.stroke} fill={color.fill} fillOpacity={0.3} />,
              <Bar key={`${provider}:started`} dataKey={`${provider}:started`} name={`${label} Started`} stackId="started" fill={color.fill} fillOpacity={0.6} barSize={4} />,
            ];
          })}
        </ComposedChart>
      </ResponsiveContainer>
    );
  }

  // Single provider — same as current
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} margin={CHART_MARGIN}>
        <CartesianGrid stroke="var(--b1)" vertical={false} />
        <XAxis dataKey="bucket" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: 'var(--b1)' }} minTickGap={40} tickFormatter={(v) => formatBucketLabel(v, range)} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={28} allowDecimals={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={(v) => new Date(String(v)).toLocaleString()} />
        <Area type="monotone" dataKey="active" name="Active Sessions" stroke="var(--color-s-ok)" fill="var(--color-s-ok)" fillOpacity={0.3} />
        <Bar dataKey="started" name="Sessions Started" fill="var(--color-s-ok)" fillOpacity={0.6} barSize={4} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
