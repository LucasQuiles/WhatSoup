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
    <div className="flex-1 overflow-auto" style={{ padding: 'var(--sp-4) var(--sp-5)' }}>
      {/* Range selector */}
      <div className="flex items-center" style={{ gap: 'var(--sp-2)', marginBottom: 'var(--sp-4)' }}>
        <span className="c-section-label">Range</span>
        {(['24h', '7d', '30d'] as const).map((r) => (
          <button
            key={r}
            className={`c-btn c-btn-sm ${metricsRange === r ? 'c-btn-primary' : 'c-btn-ghost'}`}
            onClick={() => setMetricsRange(r)}
          >
            {r}
          </button>
        ))}
        {metrics?.messageVolume && metrics.messageVolume.length > 0 && (
          <button
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
        <div className="flex flex-col" style={{ gap: 'var(--sp-4)' }}>
          <MetricsChart data={metrics.messageVolume} />
          {metrics.activeHours && (
            <ActiveHoursHeatmap data={metrics.activeHours} range={metricsRange} />
          )}

          {/* Token Usage Card */}
          {line?.tokenUsage && (line.tokenUsage.input > 0 || line.tokenUsage.output > 0) && (
            <section
              className="c-card font-mono"
              style={{ padding: 'var(--sp-4)', background: 'var(--color-d2)' }}
            >
              <div
                className="font-mono text-t4"
                style={{
                  fontSize: 'var(--font-size-xs)',
                  marginBottom: 'var(--sp-3)',
                  textTransform: 'uppercase',
                  letterSpacing: 'var(--tracking-label)',
                }}
              >
                Token Usage
              </div>
              <div className="flex items-center" style={{ gap: 'var(--sp-5)' }}>
                <div className="flex items-center" style={{ gap: 'var(--sp-2)' }}>
                  <div
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--color-m-pas)',
                    }}
                  />
                  <span style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-t3)' }}>Input</span>
                  <span className="font-medium" style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-t1)' }}>
                    {line.tokenUsage.input.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center" style={{ gap: 'var(--sp-2)' }}>
                  <div
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--color-m-cht)',
                    }}
                  />
                  <span style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-t3)' }}>Output</span>
                  <span className="font-medium" style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-t1)' }}>
                    {line.tokenUsage.output.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center" style={{ gap: 'var(--sp-2)' }}>
                  <Cpu size={13} strokeWidth={1.5} className="text-t4" />
                  <span style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-t4)' }}>Total</span>
                  <span style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-t2)' }}>
                    {(line.tokenUsage.input + line.tokenUsage.output).toLocaleString()}
                  </span>
                </div>
              </div>
              {/* Proportional bar */}
              <div
                style={{
                  marginTop: 'var(--sp-3)',
                  height: 6,
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--color-d4)',
                  overflow: 'hidden',
                  display: 'flex',
                }}
              >
                <div
                  style={{
                    width: `${(line.tokenUsage.input / (line.tokenUsage.input + line.tokenUsage.output)) * 100}%`,
                    background: 'var(--color-m-pas)',
                    height: '100%',
                  }}
                />
                <div
                  style={{
                    flex: 1,
                    background: 'var(--color-m-cht)',
                    height: '100%',
                  }}
                />
              </div>
            </section>
          )}

          {/* Model Configuration Card */}
          {line?.models && (
            <section
              className="c-card font-mono"
              style={{ padding: 'var(--sp-4)', background: 'var(--color-d2)' }}
            >
              <div
                className="font-mono text-t4"
                style={{
                  fontSize: 'var(--font-size-xs)',
                  marginBottom: 'var(--sp-3)',
                  textTransform: 'uppercase',
                  letterSpacing: 'var(--tracking-label)',
                }}
              >
                Model Configuration
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr',
                  gap: 'var(--sp-1) var(--sp-3)',
                }}
              >
                {Object.entries(line.models).map(([role, model]) =>
                  model ? (
                    <React.Fragment key={role}>
                      <span style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-t4)', textTransform: 'capitalize' }}>
                        {role}
                      </span>
                      <span style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-m-pas)' }}>
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
