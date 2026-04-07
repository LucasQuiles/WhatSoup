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
              <div className="c-section-label mb-[var(--sp-3)]">
                Token Usage
              </div>
              <div className="flex items-center gap-[var(--sp-5)]">
                <div className="flex items-center gap-[var(--sp-2)]">
                  <div
                    className="w-[var(--dot-header)] h-[var(--dot-header)] rounded-sm bg-[var(--color-m-pas)]"
                  />
                  <span style={{ fontSize: 'var(--font-size-data)' }} className="text-t3">Input</span>
                  <span className="font-medium text-t1" style={{ fontSize: 'var(--font-size-data)' }}>
                    {line.tokenUsage.input.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center gap-[var(--sp-2)]">
                  <div
                    className="w-[var(--dot-header)] h-[var(--dot-header)] rounded-sm bg-[var(--color-m-cht)]"
                  />
                  <span style={{ fontSize: 'var(--font-size-data)' }} className="text-t3">Output</span>
                  <span className="font-medium text-t1" style={{ fontSize: 'var(--font-size-data)' }}>
                    {line.tokenUsage.output.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center gap-[var(--sp-2)]">
                  <Cpu size={13} strokeWidth={1.5} className="text-t4" />
                  <span style={{ fontSize: 'var(--font-size-data)' }} className="text-t4">Total</span>
                  <span className="text-t2" style={{ fontSize: 'var(--font-size-data)' }}>
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
                    height: '100%',
                  }}
                  className="bg-[var(--color-m-pas)]"
                />
                <div
                  className="flex-1 bg-[var(--color-m-cht)]"
                  style={{
                    height: '100%',
                  }}
                />
              </div>
            </section>
          )}

          {/* Model Configuration Card */}
          {line?.models && (
            <section
              className="c-card font-mono p-[var(--sp-4)] bg-d2"
            >
              <div className="c-section-label mb-[var(--sp-3)]">
                Model Configuration
              </div>
              <div
                className="grid gap-y-[var(--sp-1)] gap-x-[var(--sp-3)]"
                style={{
                  gridTemplateColumns: 'auto 1fr',
                }}
              >
                {Object.entries(line.models).map(([role, model]) =>
                  model ? (
                    <React.Fragment key={role}>
                      <span style={{ fontSize: 'var(--font-size-data)' }} className="text-t4 capitalize">
                        {role}
                      </span>
                      <span style={{ fontSize: 'var(--font-size-data)' }} className="text-m-pas">
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
