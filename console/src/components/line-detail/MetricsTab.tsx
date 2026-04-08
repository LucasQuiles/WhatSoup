import React, { useState } from 'react'
import { Download, Cpu } from 'lucide-react'
import { MetricsChart } from '../MetricsChart'
import { FleetTokenChart } from '../FleetTokenChart'
import { FleetSessionChart } from '../FleetSessionChart'
import { ActiveHoursHeatmap } from '../ActiveHoursHeatmap'
import EmptyState from '../EmptyState'
import { metricsToCSV, downloadCSV } from '../../lib/csv-export'
import type { MetricsRange, LineMetrics, LineInstance } from './types'

type DetailTab = 'tokens' | 'sessions';

export function MetricsTab({
  metrics,
  metricsLoading,
  metricsError,
  metricsRange,
  setMetricsRange,
  lineName,
  line,
  onRetry,
}: {
  metrics: LineMetrics | undefined
  metricsLoading: boolean
  metricsError: Error | null
  metricsRange: MetricsRange
  setMetricsRange: (r: MetricsRange) => void
  lineName?: string
  line?: LineInstance
  onRetry?: () => void
}) {
  const [detailTab, setDetailTab] = useState<DetailTab>('tokens')
  const hasAnyData = metrics?.hasMessageData || metrics?.hasTokenData || metrics?.hasSessionData
  const hasDetailData = metrics?.hasTokenData || metrics?.hasSessionData

  return (
    <div className="flex-1 overflow-auto py-[var(--sp-4)] px-[var(--sp-5)]">
      {/* Range selector */}
      <div className="flex items-center gap-[var(--sp-2)] mb-[var(--sp-4)]">
        <span className="c-section-label">Range</span>
        {(['24h', '7d', '30d'] as const).map((r) => (
          <button
            type="button"
            key={r}
            className={`c-btn c-btn-sm ${metricsRange === r ? 'c-btn-primary' : 'c-btn-ghost'}`}
            onClick={() => setMetricsRange(r)}
          >
            {r}
          </button>
        ))}
        {metrics?.messageVolume && metrics.messageVolume.length > 0 && (
          <button
            type="button"
            className="c-btn c-btn-sm c-btn-ghost"
            onClick={() => {
              const csv = metricsToCSV(metrics.messageVolume);
              downloadCSV(csv, `${lineName ?? 'metrics'}-${metricsRange}.csv`);
            }}
            title="Export metrics as CSV"
            aria-label="Export metrics as CSV"
          >
            <Download size={14} />
          </button>
        )}
      </div>

      {metricsLoading ? (
        <EmptyState title="Loading metrics..." description="Fetching data for this instance." />
      ) : metricsError ? (
        <EmptyState
          variant="error"
          title="Failed to load metrics"
          description={metricsError.message}
          onRetry={onRetry}
        />
      ) : !hasAnyData ? (
        <EmptyState title="No metrics data" description="Metrics will appear after the instance processes messages." />
      ) : (
        <div className="flex flex-col gap-[var(--sp-4)]">
          {/* Hero: Message Volume bar chart */}
          {metrics?.hasMessageData && (
            <section className="c-card font-mono p-[var(--sp-4)] bg-d2 min-h-[var(--chart-min-h)]">
              <div className="c-section-label mb-[var(--sp-3)]">Message Volume</div>
              <MetricsChart data={metrics.messageVolume} range={metricsRange} />
            </section>
          )}

          {/* Active Hours Heatmap */}
          {metrics?.activeHours && (
            <ActiveHoursHeatmap data={metrics.activeHours} range={metricsRange} />
          )}

          {/* Detail metrics — tabbed */}
          {hasDetailData && (
            <section className="c-card font-mono p-[var(--sp-4)] bg-d2">
              <div className="flex items-center gap-[var(--sp-2)] mb-[var(--sp-3)]">
                {metrics?.hasTokenData && (
                  <button
                    type="button"
                    className={`c-btn c-btn-sm ${detailTab === 'tokens' ? 'c-btn-primary' : 'c-btn-ghost'}`}
                    onClick={() => setDetailTab('tokens')}
                  >
                    Tokens
                  </button>
                )}
                {metrics?.hasSessionData && (
                  <button
                    type="button"
                    className={`c-btn c-btn-sm ${detailTab === 'sessions' ? 'c-btn-primary' : 'c-btn-ghost'}`}
                    onClick={() => setDetailTab('sessions')}
                  >
                    Sessions
                  </button>
                )}
              </div>
              <div className="h-[var(--chart-min-h)]">
                {detailTab === 'tokens' && metrics?.hasTokenData && (
                  <FleetTokenChart
                    data={metrics.tokenUsage}
                    byProvider={metrics.tokenUsageByProvider}
                    providers={metrics.providers}
                    range={metricsRange}
                  />
                )}
                {detailTab === 'sessions' && metrics?.hasSessionData && (
                  <FleetSessionChart
                    data={metrics.sessionActivity}
                    byProvider={metrics.sessionActivityByProvider}
                    providers={metrics.providers}
                    range={metricsRange}
                  />
                )}
              </div>
            </section>
          )}

          {/* Token Usage Card (static totals) */}
          {line?.tokenUsage && (line.tokenUsage.input > 0 || line.tokenUsage.output > 0) && (
            <section className="c-card font-mono p-[var(--sp-4)] bg-d2">
              <div className="c-section-label mb-[var(--sp-3)]">Token Usage</div>
              <div className="flex items-center gap-[var(--sp-5)]">
                <div className="flex items-center gap-[var(--sp-2)]">
                  <div className="w-[var(--dot-header)] h-[var(--dot-header)] rounded-sm bg-[var(--color-m-agt)] opacity-50" />
                  <span className="text-data text-t3">Input</span>
                  <span className="font-medium text-t1 text-data">
                    {line.tokenUsage.input.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center gap-[var(--sp-2)]">
                  <div className="w-[var(--dot-header)] h-[var(--dot-header)] rounded-sm bg-[var(--color-m-agt)]" />
                  <span className="text-data text-t3">Output</span>
                  <span className="font-medium text-t1 text-data">
                    {line.tokenUsage.output.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center gap-[var(--sp-2)]">
                  <Cpu size={13} strokeWidth={1.5} className="text-t4" />
                  <span className="text-data text-t4">Total</span>
                  <span className="text-t2 text-data">
                    {(line.tokenUsage.input + line.tokenUsage.output).toLocaleString()}
                  </span>
                </div>
              </div>
              <div className="mt-[var(--sp-3)] h-[var(--dot-feed)] rounded-sm bg-d4 overflow-hidden flex">
                <div
                  style={{
                    width: `${(line.tokenUsage.input / (line.tokenUsage.input + line.tokenUsage.output)) * 100}%`,
                    height: '100%',
                  }}
                  className="bg-[var(--color-m-agt)] opacity-50"
                />
                <div className="flex-1 bg-[var(--color-m-agt)]" style={{ height: '100%' }} />
              </div>
            </section>
          )}

          {/* Model Configuration Card */}
          {line?.models && (
            <section className="c-card font-mono p-[var(--sp-4)] bg-d2">
              <div className="c-section-label mb-[var(--sp-3)]">Model Configuration</div>
              <div
                className="grid gap-y-[var(--sp-1)] gap-x-[var(--sp-3)]"
                style={{ gridTemplateColumns: 'auto 1fr' }}
              >
                {Object.entries(line.models).map(([role, model]) =>
                  model ? (
                    <React.Fragment key={role}>
                      <span className="text-data text-t4 capitalize">{role}</span>
                      <span className="text-data text-m-pas">{model}</span>
                    </React.Fragment>
                  ) : null
                )}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
