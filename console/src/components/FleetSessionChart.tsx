import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { SessionActivityBucket, MetricsRange } from '../types';
import { AXIS_TICK, CHART_MARGIN, TOOLTIP_STYLE, formatBucketLabel } from '../lib/chart-utils.js';

interface FleetSessionChartProps {
  data: SessionActivityBucket[];
  range?: MetricsRange;
}

/** Composed chart with area (active sessions) + bar (sessions started). */
export function FleetSessionChart({ data, range = '24h' }: FleetSessionChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} margin={CHART_MARGIN}>
        <CartesianGrid stroke="var(--b1)" vertical={false} />
        <XAxis
          dataKey="bucket"
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: 'var(--b1)' }}
          minTickGap={40}
          tickFormatter={(v) => formatBucketLabel(v, range)}
        />
        <YAxis
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          width={28}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelFormatter={(v) => new Date(String(v)).toLocaleString()}
        />
        <Area
          type="monotone"
          dataKey="active"
          name="Active Sessions"
          stroke="var(--color-s-ok)"
          fill="var(--color-s-ok)"
          fillOpacity={0.3}
        />
        <Bar
          dataKey="started"
          name="Sessions Started"
          fill="var(--color-s-ok)"
          fillOpacity={0.6}
          barSize={4}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
