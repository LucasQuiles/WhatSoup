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
import { AXIS_TICK, CHART_MARGIN, LEGEND_STYLE, MESSAGE_VOLUME_SERIES_COLORS, TOOLTIP_STYLE, formatBucketLabel, formatTooltipLabel } from '../lib/chart-utils.js';

interface FleetMetricsChartProps {
  data: MessageVolumeBucket[];
  range?: MetricsRange;
}

/** Stacked area chart showing fleet-wide inbound/outbound/media message volume. */
export function FleetMetricsChart({ data, range = '24h' }: FleetMetricsChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={CHART_MARGIN}>
        <CartesianGrid stroke="var(--border-hairline)" vertical={false} />
        <XAxis
          dataKey="bucket"
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: 'var(--border-hairline)' }}
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
        <Legend wrapperStyle={LEGEND_STYLE} />
        <Area
          type="monotone"
          dataKey="inbound"
          name="Inbound"
          stackId="msgs"
          stroke={MESSAGE_VOLUME_SERIES_COLORS.inbound}
          fill={MESSAGE_VOLUME_SERIES_COLORS.inbound}
          fillOpacity={0.3}
        />
        <Area
          type="monotone"
          dataKey="outbound"
          name="Outbound"
          stackId="msgs"
          stroke={MESSAGE_VOLUME_SERIES_COLORS.outbound}
          fill={MESSAGE_VOLUME_SERIES_COLORS.outbound}
          fillOpacity={0.3}
        />
        <Area
          type="monotone"
          dataKey="media"
          name="Media"
          stackId="msgs"
          stroke={MESSAGE_VOLUME_SERIES_COLORS.media}
          fill={MESSAGE_VOLUME_SERIES_COLORS.media}
          fillOpacity={0.2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
