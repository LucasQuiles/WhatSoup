import { MetricsChart } from '../MetricsChart'
import { ActiveHoursHeatmap } from '../ActiveHoursHeatmap'
import EmptyState from '../EmptyState'
import type { MetricsRange, LineMetrics } from './types'

export function MetricsTab({
  metrics,
  metricsLoading,
  metricsError,
  metricsRange,
  setMetricsRange,
}: {
  metrics: LineMetrics | undefined
  metricsLoading: boolean
  metricsError: Error | null
  metricsRange: MetricsRange
  setMetricsRange: (r: MetricsRange) => void
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
            <ActiveHoursHeatmap data={metrics.activeHours} />
          )}
        </div>
      ) : (
        <EmptyState title="No metrics data" description="Metrics will appear after the instance processes messages." />
      )}
    </div>
  )
}
