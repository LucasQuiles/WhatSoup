import React, { useState } from 'react'
import { Download, Cpu } from 'lucide-react'
import { MetricsChart } from '../MetricsChart'
import { FleetTokenChart } from '../FleetTokenChart'
import { FleetSessionChart } from '../FleetSessionChart'
import { ActiveHoursHeatmap } from '../ActiveHoursHeatmap'
import EmptyState from '../EmptyState'
import { metricsToCSV, downloadCSV } from '../../lib/csv-export'
import { formatCount } from '../../lib/text-utils'
import { formatRelative } from '../../lib/format-time'
import type { Freshness } from '../../lib/freshness'
import { Card, ToolbarTimeRange, Tabs, Tab, TabPanel } from '../primitives'
import { Button } from '../primitives/Button'
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
  metricsFreshness,
}: {
  metrics: LineMetrics | undefined
  metricsLoading: boolean
  metricsError: Error | null
  metricsRange: MetricsRange
  setMetricsRange: (r: MetricsRange) => void
  lineName?: string
  line?: LineInstance
  onRetry?: () => void
  metricsFreshness?: Freshness
}) {
  const [detailTab, setDetailTab] = useState<DetailTab>('tokens')
  const hasAnyData = metrics?.hasMessageData || metrics?.hasTokenData || metrics?.hasSessionData
  const hasDetailData = metrics?.hasTokenData || metrics?.hasSessionData
  const activeDetailTab: DetailTab =
    detailTab === 'sessions' && metrics?.hasSessionData
      ? 'sessions'
      : metrics?.hasTokenData
        ? 'tokens'
        : metrics?.hasSessionData
          ? 'sessions'
          : detailTab

  return (
    <div className="flex-1 min-h-0 min-w-0 overflow-auto py-[var(--sp-4)] px-[var(--sp-5)]">
      {/* Range selector */}
      <div className="flex items-center gap-[var(--sp-2)] mb-[var(--sp-4)]">
        <ToolbarTimeRange
          label="Time range"
          options={[
            { label: '24h', value: '24h' },
            { label: '7d', value: '7d' },
            { label: '30d', value: '30d' },
          ]}
          value={metricsRange}
          onChange={(v) => setMetricsRange(v as MetricsRange)}
        />
        {/* GUI-5: label carried/aged metrics data — never silently green.
            Mirrors the SoupKitchen freshness idiom (c-label + text-s-warn). */}
        {metricsFreshness && metricsFreshness.observedAt !== null && (
          <span
            className={`c-label${metricsFreshness.stale ? ' text-s-warn' : ''}`}
            title={
              metricsFreshness.stale
                ? `Metrics carried forward — last successful fetch ${formatRelative(new Date(metricsFreshness.observedAt).toISOString())}`
                : `Last successful metrics fetch ${formatRelative(new Date(metricsFreshness.observedAt).toISOString())}`
            }
          >
            {metricsFreshness.stale
              ? `stale · ${formatRelative(new Date(metricsFreshness.observedAt).toISOString())}`
              : `observed ${formatRelative(new Date(metricsFreshness.observedAt).toISOString())}`}
          </span>
        )}
        {metrics?.messageVolume && metrics.messageVolume.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const csv = metricsToCSV(metrics.messageVolume);
              downloadCSV(csv, `${lineName ?? 'metrics'}-${metricsRange}.csv`);
            }}
            title="Export metrics as CSV"
            aria-label="Export metrics as CSV"
            icon={<Download size={14} />}
          />
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
            <Card variant="base" as="section" className="font-mono p-[var(--sp-4)] min-h-[var(--chart-min-h)]">
              <div className="c-section-label mb-[var(--sp-3)]">Message Volume</div>
              <MetricsChart data={metrics.messageVolume} range={metricsRange} />
            </Card>
          )}

          {/* Active Hours Heatmap */}
          {metrics?.activeHours && (
            <ActiveHoursHeatmap data={metrics.activeHours} byDate={metrics.activeHoursByDate} range={metricsRange} />
          )}

          {/* Detail metrics — tabbed */}
          {hasDetailData && (
            <Card variant="base" as="section" className="font-mono p-[var(--sp-4)]">
              <Tabs
                label="Metric detail series"
                value={activeDetailTab}
                onChange={(id) => setDetailTab(id as DetailTab)}
                className="mb-[var(--sp-3)]"
              >
                {metrics?.hasTokenData && (
                  <Tab id="tokens">Tokens</Tab>
                )}
                {metrics?.hasSessionData && (
                  <Tab id="sessions">Sessions</Tab>
                )}
              </Tabs>
              <div className="h-[var(--chart-min-h)]">
                {activeDetailTab === 'tokens' && metrics?.hasTokenData && (
                  <TabPanel id="tokens" active={activeDetailTab} className="h-full">
                    <FleetTokenChart
                      data={metrics.tokenUsage}
                      byProvider={metrics.tokenUsageByProvider}
                      providers={metrics.providers}
                      range={metricsRange}
                    />
                  </TabPanel>
                )}
                {activeDetailTab === 'sessions' && metrics?.hasSessionData && (
                  <TabPanel id="sessions" active={activeDetailTab} className="h-full">
                    <FleetSessionChart
                      data={metrics.sessionActivity}
                      byProvider={metrics.sessionActivityByProvider}
                      providers={metrics.providers}
                      range={metricsRange}
                    />
                  </TabPanel>
                )}
              </div>
            </Card>
          )}

          {/* Token Usage Card (static totals) */}
          {line?.tokenUsage && (line.tokenUsage.input > 0 || line.tokenUsage.output > 0) && (
            <Card variant="base" as="section" className="font-mono p-[var(--sp-4)]">
              <div className="c-section-label mb-[var(--sp-3)]">Token Usage</div>
              <div className="flex items-center gap-[var(--sp-5)]">
                <div className="flex items-center gap-[var(--sp-2)]">
                  <div className="w-[var(--dot-header)] h-[var(--dot-header)] rounded-sm bg-[var(--data-token-input-solid)] opacity-50" />
                  <span className="text-data text-text-2">Input</span>
                  <span className="font-medium text-text-1 text-data">
                    {formatCount(line.tokenUsage.input)}
                  </span>
                </div>
                <div className="flex items-center gap-[var(--sp-2)]">
                  <div className="w-[var(--dot-header)] h-[var(--dot-header)] rounded-sm bg-[var(--data-token-output-solid)]" />
                  <span className="text-data text-text-2">Output</span>
                  <span className="font-medium text-text-1 text-data">
                    {formatCount(line.tokenUsage.output)}
                  </span>
                </div>
                <div className="flex items-center gap-[var(--sp-2)]">
                  <Cpu size={13} strokeWidth={1.5} className="text-text-2" />
                  <span className="text-data text-text-2">Total</span>
                  <span className="text-text-2 text-data">
                    {formatCount(line.tokenUsage.input + line.tokenUsage.output)}
                  </span>
                </div>
              </div>
              <div className="mt-[var(--sp-3)] h-[var(--dot-feed)] rounded-sm bg-btn-neutral-bg overflow-hidden flex">
                <div
                  style={{
                    width: `${(line.tokenUsage.input / (line.tokenUsage.input + line.tokenUsage.output)) * 100}%`,
                    height: '100%',
                  }}
                  className="bg-[var(--data-token-input-solid)] opacity-50"
                />
                <div className="flex-1 bg-[var(--data-token-output-solid)]" style={{ height: '100%' }} />
              </div>
            </Card>
          )}

          {/* Model Configuration Card */}
          {line?.models && (
            <Card variant="base" as="section" className="font-mono p-[var(--sp-4)]">
              <div className="c-section-label mb-[var(--sp-3)]">Model Configuration</div>
              <div
                className="grid gap-y-[var(--sp-1)] gap-x-[var(--sp-3)]"
                style={{ gridTemplateColumns: 'auto 1fr' }}
              >
                {Object.entries(line.models).map(([role, model]) =>
                  model ? (
                    <React.Fragment key={role}>
                      <span className="text-data text-text-2 capitalize">{role}</span>
                      <span className="text-data text-m-pas">{model}</span>
                    </React.Fragment>
                  ) : null
                )}
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  )
}
