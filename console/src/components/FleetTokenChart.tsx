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
import { AXIS_TICK, CHART_MARGIN, LEGEND_STYLE, TOOLTIP_STYLE, formatBucketLabel, formatTooltipLabel } from '../lib/chart-utils.js';
import { formatCompact, formatCount } from '../lib/text-utils';
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
            tickFormatter={(v) => formatCompact(Number(v) || 0)}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelFormatter={(v) => formatTooltipLabel(String(v), range)}
            formatter={(value, name) => [
              formatCount(Number(value) || 0),
              String(name),
            ]}
          />
          <Legend wrapperStyle={LEGEND_STYLE} />
          {providers.flatMap((provider) => {
            const color = getProviderColor(provider);
            const prov = getProvider(provider);
            const label = prov?.shortName ?? provider;
            return [
              <Area
                key={`${provider}:output`}
                type="monotone"
                dataKey={`${provider}:output`}
                name={`${label} Out`}
                stackId="output"
                stroke={color.stroke}
                fill={color.fill}
                fillOpacity={0.3}
              />,
              <Area
                key={`${provider}:input`}
                type="monotone"
                dataKey={`${provider}:input`}
                name={`${label} In`}
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
          tickFormatter={(v) => formatCompact(Number(v) || 0)}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelFormatter={(v) => formatTooltipLabel(String(v), range)}
          formatter={(value, name) => [
            formatCount(Number(value) || 0),
            String(name),
          ]}
        />
        <Area
          type="monotone"
          dataKey="output"
          name="Output Tokens"
          stackId="tokens"
          stroke="var(--data-token-output-solid)"
          fill="var(--data-token-output-solid)"
          fillOpacity={0.3}
        />
        <Area
          type="monotone"
          dataKey="input"
          name="Input Tokens"
          stackId="tokens"
          stroke="var(--data-token-input-solid)"
          strokeDasharray="4 2"
          fill="var(--data-token-input-solid)"
          fillOpacity={0.15}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
