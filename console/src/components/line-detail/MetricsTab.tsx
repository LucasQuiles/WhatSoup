import React from 'react'
import { Download, Cpu } from 'lucide-react'
import { MetricsChart } from '../MetricsChart'
import { ActiveHoursHeatmap } from '../ActiveHoursHeatmap'
import EmptyState from '../EmptyState'
import { metricsToCSV, downloadCSV } from '../../lib/csv-export'
import type { MetricsRange, LineMetrics, LineInstance } from './types'

export function MetricsTab({
  metrics,
  metricsLoading,
  metricsError,
  metricsRange,
  setMetricsRange,
  lineName,
  line,
}: {
  metrics: LineMetrics | undefined
  metricsLoading: boolean
  metricsError: Error | null
  metricsRange: MetricsRange
  setMetricsRange: (r: MetricsRange) => void
  lineName?: string
  line?: LineInstance
}) {
  return (
    <div className="flex-1 overflow-auto py-[var(--sp-4)] px-[var(--sp-5)]">
      {/* Range selector */}
      <div className="flex items-center gap-[var(--sp-2)] mb-[var(--sp-4)]">
        <span className="c-section-label">Range</span>
        {(['24h', '7d', '30d'] as const).map((r) => (
          <button
            key={r}
            type="button"
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
          onRetry={() => setMetricsRange(metricsRange)}
        />
      ) : metrics?.messageVolume && metrics.messageVolume.length > 0 ? (
        <div className="flex flex-col gap-[var(--sp-4)]">
          <MetricsChart data={metrics.messageVolume} />
          {metrics.activeHours && (
            <ActiveHoursHeatmap data={metrics.activeHours} range={metricsRange} />
          )}

          {/* Token Usage Card */}
          {line?.tokenUsage && (line.tokenUsage.input > 0 || line.tokenUsage.output > 0) && (
            <section
              className="c-card font-mono p-[var(--sp-4)] bg-d2"
            >
              <div
                className="font-mono text-t4 text-[var(--font-size-xs)] mb-[var(--sp-3)] uppercase tracking-[var(--tracking-label)]"
              >
                Token Usage
              </div>
              <div className="flex items-center gap-[var(--sp-5)]">
                <div className="flex items-center gap-[var(--sp-2)]">
                  <div
                    className="w-[var(--dot-header)] h-[var(--dot-header)] rounded-sm bg-m-pas"
                  />
                  <span className="text-[var(--font-size-data)] text-t3">Input</span>
                  <span className="font-medium text-[var(--font-size-data)] text-t1">
                    {line.tokenUsage.input.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center gap-[var(--sp-2)]">
                  <div
                    className="w-[var(--dot-header)] h-[var(--dot-header)] rounded-sm bg-m-cht"
                  />
                  <span className="text-[var(--font-size-data)] text-t3">Output</span>
                  <span className="font-medium text-[var(--font-size-data)] text-t1">
                    {line.tokenUsage.output.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center gap-[var(--sp-2)]">
                  <Cpu size={13} strokeWidth={1.5} className="text-t4" />
                  <span className="text-[var(--font-size-data)] text-t4">Total</span>
                  <span className="text-[var(--font-size-data)] text-t2">
                    {(line.tokenUsage.input + line.tokenUsage.output).toLocaleString()}
                  </span>
                </div>
              </div>
              {/* Proportional bar */}
              <div
                className="mt-[var(--sp-3)] h-[var(--dot-feed)] rounded-sm bg-d4 overflow-hidden flex"
              >
                <div
                  style={{
                    width: `${(line.tokenUsage.input / (line.tokenUsage.input + line.tokenUsage.output)) * 100}%`,
                  }}
                  className="bg-m-pas h-full"
                />
                <div
                  className="flex-1 bg-m-cht h-full"
                />
              </div>
            </section>
          )}

          {/* Model Configuration Card */}
          {line?.models && (
            <section
              className="c-card font-mono p-[var(--sp-4)] bg-d2"
            >
              <div
                className="font-mono text-t4 text-[var(--font-size-xs)] mb-[var(--sp-3)] uppercase tracking-[var(--tracking-label)]"
              >
                Model Configuration
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr',
                  rowGap: 'var(--sp-1)',
                  columnGap: 'var(--sp-3)',
                }}
              >
                {Object.entries(line.models).map(([role, model]) =>
                  model ? (
                    <React.Fragment key={role}>
                      <span className="text-[var(--font-size-data)] text-t4 capitalize">
                        {role}
                      </span>
                      <span className="text-[var(--font-size-data)] text-m-pas">
                        {model}
                      </span>
                    </React.Fragment>
                  ) : null
                )}
              </div>
            </section>
          )}
        </div>
      ) : (
        <EmptyState title="No metrics data" description="Metrics will appear after the instance processes messages." />
      )}
    </div>
  )
}
