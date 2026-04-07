import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TokenUsageBucket, MetricsRange } from '../types';
import { AXIS_TICK, CHART_MARGIN, TOOLTIP_STYLE, formatBucketLabel } from '../lib/chart-utils.js';
import { formatCompact } from '../lib/text-utils';

interface FleetTokenChartProps {
  data: TokenUsageBucket[];
  range?: MetricsRange;
}

/** Area chart showing fleet-wide token consumption (input + output). */
export function FleetTokenChart({ data, range = '24h' }: FleetTokenChartProps) {
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
          width={36}
          allowDecimals={false}
          tickFormatter={(v) => formatCompact(Number(v) || 0)}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelFormatter={(v) => new Date(String(v)).toLocaleString()}
          formatter={(value, name) => [
            (Number(value) || 0).toLocaleString(),
            String(name),
          ]}
        />
        <Area
          type="monotone"
          dataKey="output"
          name="Output Tokens"
          stroke="var(--color-m-agt)"
          fill="var(--color-m-agt)"
          fillOpacity={0.3}
        />
        <Area
          type="monotone"
          dataKey="input"
          name="Input Tokens"
          stroke="var(--color-m-agt)"
          strokeDasharray="4 2"
          fill="var(--color-m-agt)"
          fillOpacity={0.15}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
