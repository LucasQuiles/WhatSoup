/**
 * OpsMetrics — the fleet metrics surface, absorbed into Ops (T5 b-09a).
 * This is the former /metrics page content (KPI strip + Fleet Metrics card
 * with freshness caption + message-volume and token charts), rehomed per the
 * Ops consolidation (02-mapping §2, E4): /metrics redirects here.
 */
import { useMemo, useState } from 'react'
import { useLines, useFeed } from '../../hooks/use-fleet'
import { useFleetMetrics } from '../../hooks/use-metrics'
import { computeKpis } from '../../lib/compute-kpis'
import type { LineInstance, MessageVolumeBucket, TokenUsageBucket, MetricsRange } from '../../types'
import KpiCard from '../KpiCard'
import { ChartPanel } from '../ChartPanel'
import { FleetMetricsChart } from '../FleetMetricsChart'
import { FleetTokenChart } from '../FleetTokenChart'
import { Button, Card, ToolbarTimeRange, type TimeRangeOption } from '../primitives'
import { formatCount, formatCompact } from '../../lib/text-utils'
import { formatRelative } from '../../lib/format-time'
import { RotateCw } from 'lucide-react'

const RANGE_OPTIONS: TimeRangeOption[] = [
  { label: '24h', value: '24h' },
  { label: '7d', value: '7d' },
  { label: '30d', value: '30d' },
]

const EMPTY_LINES: LineInstance[] = []

function sumMessages(buckets: MessageVolumeBucket[] | undefined): number {
  if (!buckets) return 0
  let sum = 0
  for (const b of buckets) sum += b.inbound + b.outbound + b.media
  return sum
}

function sumTokens(buckets: TokenUsageBucket[] | undefined): number {
  if (!buckets) return 0
  let sum = 0
  for (const b of buckets) sum += b.input + b.output
  return sum
}

export function OpsMetrics() {
  const {
    data: lineData,
    isError: linesError,
    error: linesQueryError,
    refetch: refetchLines,
  } = useLines()
  useFeed()

  const lines = lineData ?? EMPTY_LINES

  const [chartRange, setChartRange] = useState<MetricsRange>('24h')
  const {
    data: fleetMetrics,
    isLoading: metricsLoading,
    isError: metricsError,
    refetch: metricsRefetch,
    freshness: metricsFreshness,
  } = useFleetMetrics(chartRange)

  const kpis = useMemo(() => computeKpis(lines), [lines])
  const totalMessages = useMemo(
    () => sumMessages(fleetMetrics?.messageVolume),
    [fleetMetrics?.messageVolume],
  )
  const totalTokens = useMemo(
    () => sumTokens(fleetMetrics?.tokenUsage),
    [fleetMetrics?.tokenUsage],
  )

  // "Lines Online" is a HEALTH-STATE count (status === 'online') — see the
  // #1881 note in the original page: it deliberately differs from the Fleet
  // view's transport-state "Lines Connected" KPI.
  const onlineCount = useMemo(
    () => lines.filter((l) => l.status === 'online').length,
    [lines],
  )

  const meta = fleetMetrics?.meta
  const instancesFailed = meta?.instancesFailed ?? 0

  const fleetLoadErrorMessage = linesQueryError?.message ?? 'Unable to load fleet data'

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-x-hidden overflow-y-auto p-[var(--sp-4)] gap-[var(--sp-3)]">
      <div className="flex-shrink-0">
        <Card className="flex flex-wrap gap-[var(--sp-2)] p-[var(--sp-2)]">
          <KpiCard value={lines.length} label="Total Lines" color="neutral" />
          <KpiCard value={onlineCount} label="Lines Online" color="text-s-ok" />
          <KpiCard value={kpis.needAttention} label="Need Attention" color="text-s-crit" />
          <KpiCard value={formatCount(totalMessages)} label={`Messages (${chartRange})`} color="neutral" />
          <KpiCard value={formatCompact(totalTokens)} label={`Tokens (${chartRange})`} color="neutral" />
        </Card>
      </div>

      <div className="flex-shrink-0">
        <Card className="p-[var(--sp-2)] flex flex-col gap-[var(--sp-2)]">
          <div className="flex items-center justify-between">
            <h2 className="c-heading-lg">Fleet Metrics</h2>
            <div className="flex items-center gap-[var(--sp-2)]">
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
                    if (linesError) void refetchLines()
                    if (metricsError) void metricsRefetch()
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
                <FleetMetricsChart data={fleetMetrics.messageVolume} range={chartRange} />
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
      </div>
    </div>
  )
}
