import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MessageVolumeBucket, MetricsRange } from '../types';
import { AXIS_TICK, CHART_MARGIN, LEGEND_STYLE, MESSAGE_VOLUME_SERIES_COLORS, TOOLTIP_STYLE, formatBucketLabel, formatTooltipLabel } from '../lib/chart-utils.js';

interface MetricsChartProps {
  data: MessageVolumeBucket[];
  range?: MetricsRange;
}

export function MetricsChart({ data, range = '24h' }: MetricsChartProps) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data} margin={CHART_MARGIN}>
        <CartesianGrid stroke="var(--border-hairline)" vertical={false} />
        <XAxis
          dataKey="bucket"
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: 'var(--border-hairline)' }}
          minTickGap={24}
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
        <Bar dataKey="inbound" name="Inbound" stackId="messages" fill={MESSAGE_VOLUME_SERIES_COLORS.inbound} radius={[2, 2, 0, 0]} />
        <Bar dataKey="outbound" name="Outbound" stackId="messages" fill={MESSAGE_VOLUME_SERIES_COLORS.outbound} radius={[2, 2, 0, 0]} />
        <Bar dataKey="media" name="Media" stackId="messages" fill={MESSAGE_VOLUME_SERIES_COLORS.media} radius={[2, 2, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
