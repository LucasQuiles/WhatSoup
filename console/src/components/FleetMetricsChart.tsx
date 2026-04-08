import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MessageVolumeBucket, MetricsRange } from '../types';
import { AXIS_TICK, CHART_MARGIN, TOOLTIP_STYLE, formatBucketLabel, formatTooltipLabel } from '../lib/chart-utils.js';

interface FleetMetricsChartProps {
  data: MessageVolumeBucket[];
  range?: MetricsRange;
}

/** Stacked area chart showing fleet-wide inbound/outbound/media message volume. */
export function FleetMetricsChart({ data, range = '24h' }: FleetMetricsChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={CHART_MARGIN}>
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
          width={32}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelFormatter={(v) => formatTooltipLabel(String(v), range)}
        />
        <Legend wrapperStyle={{ fontSize: 'var(--text-xs)' }} />
        <Area
          type="monotone"
          dataKey="inbound"
          name="Inbound"
          stackId="msgs"
          stroke="var(--color-m-pas)"
          fill="var(--color-m-pas)"
          fillOpacity={0.3}
        />
        <Area
          type="monotone"
          dataKey="outbound"
          name="Outbound"
          stackId="msgs"
          stroke="var(--color-m-cht)"
          fill="var(--color-m-cht)"
          fillOpacity={0.3}
        />
        <Area
          type="monotone"
          dataKey="media"
          name="Media"
          stackId="msgs"
          stroke="var(--color-s-warn)"
          fill="var(--color-s-warn)"
          fillOpacity={0.2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
