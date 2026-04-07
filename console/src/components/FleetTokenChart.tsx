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
import type { TokenUsageBucket, MetricsRange } from '../types';
import { AXIS_TICK, CHART_MARGIN, TOOLTIP_STYLE, formatBucketLabel } from '../lib/chart-utils.js';
import { formatCompact } from '../lib/text-utils';
import { getProvider, getProviderColor } from '../lib/providers';

interface FleetTokenChartProps {
  data: TokenUsageBucket[];
  byProvider?: Record<string, TokenUsageBucket[]>;
  providers?: string[];
  range?: MetricsRange;
}

/** Area chart showing fleet-wide token consumption (input + output). */
export function FleetTokenChart({ data, byProvider, providers, range = '24h' }: FleetTokenChartProps) {
  const multiProvider = providers && providers.length > 1 && byProvider;

  if (multiProvider) {
    const merged = data.map((bucket, i) => {
      const row: Record<string, unknown> = { bucket: bucket.bucket };
      for (const provider of providers) {
        const pb = byProvider[provider]?.[i];
        row[`${provider}:output`] = pb?.output ?? 0;
        row[`${provider}:input`] = pb?.input ?? 0;
      }
      return row;
    });

    return (
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={merged} margin={CHART_MARGIN}>
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
          <Legend wrapperStyle={{ fontSize: 'var(--font-size-xs)' }} />
          {providers.flatMap((provider) => {
            const color = getProviderColor(provider);
            const displayName = getProvider(provider)?.displayName ?? provider;
            return [
              <Area
                key={`${provider}:output`}
                type="monotone"
                dataKey={`${provider}:output`}
                name={`${displayName} Out`}
                stackId="output"
                stroke={color.stroke}
                fill={color.fill}
                fillOpacity={0.3}
              />,
              <Area
                key={`${provider}:input`}
                type="monotone"
                dataKey={`${provider}:input`}
                name={`${displayName} In`}
                stackId="input"
                stroke={color.stroke}
                strokeDasharray="4 2"
                fill={color.fill}
                fillOpacity={0.15}
              />,
            ];
          })}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  // Single provider — same as current
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
