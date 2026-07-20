import {
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import type { TokenUsageBucket, MetricsRange } from '../types';
import { LEGEND_STYLE, TOOLTIP_STYLE } from '../lib/chart-utils.js';
import { formatCompact, formatCount } from '../lib/text-utils';
import { getProvider, getProviderColor } from '../lib/providers';

interface FleetTokenChartProps {
  data: TokenUsageBucket[];
  byProvider?: Record<string, TokenUsageBucket[]>;
  providers?: string[];
  range?: MetricsRange;
}

interface DonutSegment {
  /** Stable key — provider id, or 'input'/'output' in the single-provider fallback. */
  key: string;
  /** Legend / tooltip label. */
  name: string;
  /** Total token count for this segment. */
  value: number;
  /** Segment colour — a v3 design-token CSS variable, never a raw hex. */
  fill: string;
}

/** Sum input + output tokens across every bucket. */
function totalTokens(buckets: TokenUsageBucket[] | undefined): number {
  if (!buckets) return 0;
  let sum = 0;
  for (const b of buckets) sum += (b.input ?? 0) + (b.output ?? 0);
  return sum;
}

/**
 * Donut (ring) chart of fleet token spend.
 *
 * Multi-provider (more than one provider with a `byProvider` breakdown): one ring
 * segment per provider, sized by that provider's total token spend and coloured
 * from the locked `--provider-*` palette via {@link getProviderColor}.
 *
 * Single provider / no breakdown: a two-segment ring of total input vs output
 * tokens, so the ring still carries meaning rather than collapsing to a degenerate
 * single arc. These two segments use the sanctioned data-series token palette
 * (`--data-token-input-solid` / `--data-token-output-solid`).
 */
export function FleetTokenChart({ data, byProvider, providers }: FleetTokenChartProps) {
  const multiProvider = providers && providers.length > 1 && byProvider;

  let segments: DonutSegment[];
  let showLegend: boolean;

  if (multiProvider) {
    segments = providers.map((provider) => {
      const prov = getProvider(provider);
      return {
        key: provider,
        name: prov?.shortName ?? provider,
        value: totalTokens(byProvider[provider]),
        fill: getProviderColor(provider).fill,
      };
    });
    showLegend = true;
  } else {
    // Single provider / no breakdown — input vs output of the merged series.
    let input = 0;
    let output = 0;
    for (const b of data) {
      input += b.input ?? 0;
      output += b.output ?? 0;
    }
    segments = [
      { key: 'output', name: 'Output Tokens', value: output, fill: 'var(--data-token-output-solid)' },
      { key: 'input', name: 'Input Tokens', value: input, fill: 'var(--data-token-input-solid)' },
    ];
    showLegend = false;
  }

  const grandTotal = segments.reduce((sum, s) => sum + s.value, 0);

  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          formatter={(value, name) => [formatCount(Number(value) || 0), String(name)]}
        />
        {showLegend ? <Legend wrapperStyle={LEGEND_STYLE} /> : null}
        <Pie
          data={segments}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          innerRadius="58%"
          outerRadius="82%"
          paddingAngle={2}
          stroke="var(--border-hairline)"
          isAnimationActive={false}
        >
          {segments.map((segment) => (
            <Cell key={segment.key} fill={segment.fill} />
          ))}
        </Pie>
        {/* Center total — sum of all token spend, mirroring the showcase ring label. */}
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          fill="var(--text-1)"
          fontSize="var(--text-lg)"
          fontFamily="var(--font-mono)"
          aria-label="Total tokens"
        >
          <tspan x="50%" dy="-0.2em" fontWeight={700}>
            {formatCompact(grandTotal)}
          </tspan>
          <tspan x="50%" dy="1.3em" fill="var(--text-2)" fontSize="var(--text-xs)">
            TOKENS
          </tspan>
        </text>
      </PieChart>
    </ResponsiveContainer>
  );
}
