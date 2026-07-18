import { type FC, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useLines, useFeed } from "../hooks/use-fleet";
import { useFleetMetrics } from "../hooks/use-metrics";
import { computeKpis } from "../lib/compute-kpis";
import type {
  LineInstance,
  MessageVolumeBucket,
  TokenUsageBucket,
  MetricsRange,
} from "../types";
import KpiCard from "../components/KpiCard";
import { ChartPanel } from "../components/ChartPanel";
import { FleetMetricsChart } from "../components/FleetMetricsChart";
import { FleetTokenChart } from "../components/FleetTokenChart";
import { Button, Card, ToolbarTimeRange, type TimeRangeOption } from "../components/primitives";
import { formatCount, formatCompact } from "../lib/text-utils";
import { formatRelative } from "../lib/format-time";
import { RotateCw } from "lucide-react";

const ease = [0.22, 1, 0.36, 1] as const;

const RANGE_OPTIONS: TimeRangeOption[] = [
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
];

const EMPTY_LINES: LineInstance[] = [];

/** Total inbound + outbound + media messages across every volume bucket. */
function sumMessages(buckets: MessageVolumeBucket[] | undefined): number {
  if (!buckets) return 0;
  let sum = 0;
  for (const b of buckets) sum += b.inbound + b.outbound + b.media;
  return sum;
}

/** Total input + output tokens across every token bucket. */
function sumTokens(buckets: TokenUsageBucket[] | undefined): number {
  if (!buckets) return 0;
  let sum = 0;
  for (const b of buckets) sum += b.input + b.output;
  return sum;
}

/**
 * Metrics — fleet-wide aggregate dashboard.
 *
 * Standalone destination that COMPOSES the existing fleet metrics surface:
 *  - KPI cells sourced from the same fleet hooks the Fleet view uses
 *    (`useLines` → computeKpis; `useFleetMetrics` → message/token totals).
 *  - The message-volume stacked bar chart (`FleetMetricsChart`) and the
 *    token-spend provider donut (`FleetTokenChart`), each framed in
 *    `ChartPanel` for its loading / empty / error states.
 *
 * The charts sit in a responsive grid — side-by-side on wide viewports,
 * stacked on narrow — and the page owns its own padded scroll region.
 */
const Metrics: FC = () => {
  const {
    data: lineData,
    isError: linesError,
    error: linesQueryError,
    refetch: refetchLines,
  } = useLines();
  // Reused to keep this destination on the same fleet data plane as the
  // Fleet/Ops views even though the page surfaces no feed list directly.
  useFeed();

  const lines = lineData ?? EMPTY_LINES;

  const [chartRange, setChartRange] = useState<MetricsRange>("24h");
  const {
    data: fleetMetrics,
    isLoading: metricsLoading,
    isError: metricsError,
    refetch: metricsRefetch,
    freshness: metricsFreshness,
  } = useFleetMetrics(chartRange);

  const kpis = useMemo(() => computeKpis(lines), [lines]);
  const totalMessages = useMemo(
    () => sumMessages(fleetMetrics?.messageVolume),
    [fleetMetrics?.messageVolume],
  );
  const totalTokens = useMemo(
    () => sumTokens(fleetMetrics?.tokenUsage),
    [fleetMetrics?.tokenUsage],
  );

  // "Lines Online" is a HEALTH-STATE count (status === 'online') — a separate
  // dimension from the Fleet view's transport-state "Lines Connected" KPI
  // (kpis.connected, which since #1881 also counts degraded-but-connected
  // lines). Deriving it directly from status keeps the "Online" label truthful
  // and decoupled from transport connectivity; the two figures legitimately
  // differ when a line is degraded but its WhatsApp transport is still up.
  const onlineCount = useMemo(
    () => lines.filter((l) => l.status === "online").length,
    [lines],
  );

  const meta = fleetMetrics?.meta;
  const instancesFailed = meta?.instancesFailed ?? 0;

  const fleetLoadErrorMessage =
    linesQueryError?.message ?? "Unable to load fleet data";

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-x-hidden overflow-y-auto p-[var(--sp-4)] gap-[var(--sp-3)]">
      {/* KPI Strip — fleet-wide aggregates from the same hooks the Fleet view
          uses. flex-wrap: multiple rows at narrow widths, no horizontal
          overflow (mirrors SoupKitchen DD-18). The card surface is the Card
          primitive (card-via-primitive, DD-38); motion.div is the entrance-
          animation wrapper only. */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease }}
        className="flex-shrink-0"
      >
        <Card className="flex flex-wrap gap-[var(--sp-2)] p-[var(--sp-2)]">
          <KpiCard value={lines.length} label="Total Lines" color="neutral" />
          <KpiCard value={onlineCount} label="Lines Online" color="text-s-ok" />
          <KpiCard
            value={kpis.needAttention}
            label="Need Attention"
            color="text-s-crit"
          />
          <KpiCard
            value={formatCount(totalMessages)}
            label={`Messages (${chartRange})`}
            color="neutral"
          />
          <KpiCard
            value={formatCompact(totalTokens)}
            label={`Tokens (${chartRange})`}
            color="neutral"
          />
        </Card>
      </motion.div>

      {/* Charts Section */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.1, ease }}
        className="flex-shrink-0"
      >
        <Card className="p-[var(--sp-2)] flex flex-col gap-[var(--sp-2)]">
        <div className="flex items-center justify-between">
          <h2 className="c-heading-lg">Fleet Metrics</h2>
          <div className="flex items-center gap-[var(--sp-2)]">
            {/* GUI-5: label carried/aged fleet metrics — never silently green. */}
            {metricsFreshness && metricsFreshness.observedAt !== null && (
              <span
                className={`c-label${metricsFreshness.stale ? ' text-s-warn' : ''}`}
                title={
                  metricsFreshness.stale
                    ? `Fleet metrics carried forward — last successful fetch ${formatRelative(new Date(metricsFreshness.observedAt).toISOString())}`
                    : `Last successful fleet metrics fetch ${formatRelative(new Date(metricsFreshness.observedAt).toISOString())}`
                }
              >
                {metricsFreshness.stale
                  ? `stale · ${formatRelative(new Date(metricsFreshness.observedAt).toISOString())}`
                  : `observed ${formatRelative(new Date(metricsFreshness.observedAt).toISOString())}`}
              </span>
            )}
            {(linesError || metricsError) && (
              <Button
                variant="ghost"
                size="sm"
                icon={<RotateCw size={12} strokeWidth={1.75} />}
                onClick={() => {
                  if (linesError) void refetchLines();
                  if (metricsError) void metricsRefetch();
                }}
              >
                Retry
              </Button>
            )}
            <ToolbarTimeRange
              label="Chart range"
              options={RANGE_OPTIONS}
              value={chartRange}
              onChange={(v) => setChartRange(v as MetricsRange)}
            />
          </div>
        </div>

        {linesError && (
          <p className="font-mono text-s-crit text-label">
            {`Fleet data unavailable: ${fleetLoadErrorMessage}`}
          </p>
        )}

        {/* Responsive grid: charts side-by-side on wide, stacked on narrow. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-[var(--sp-2)]">
          <ChartPanel
            title={`Message Volume (${chartRange})`}
            isLoading={metricsLoading}
            isError={metricsError}
            hasData={meta?.hasMessageData ?? false}
            instancesFailed={instancesFailed}
            onRetry={() => metricsRefetch()}
          >
            {fleetMetrics?.messageVolume && (
              <FleetMetricsChart
                data={fleetMetrics.messageVolume}
                range={chartRange}
              />
            )}
          </ChartPanel>

          <ChartPanel
            title={`Token Usage (${chartRange})`}
            isLoading={metricsLoading}
            isError={metricsError}
            hasData={meta?.hasTokenData ?? false}
            instancesFailed={instancesFailed}
            onRetry={() => metricsRefetch()}
          >
            {fleetMetrics?.tokenUsage && (
              <FleetTokenChart
                data={fleetMetrics.tokenUsage}
                byProvider={fleetMetrics.tokenUsageByProvider}
                providers={fleetMetrics.meta?.providers}
                range={chartRange}
              />
            )}
          </ChartPanel>
        </div>
        </Card>
      </motion.div>
    </div>
  );
};

export default Metrics;
