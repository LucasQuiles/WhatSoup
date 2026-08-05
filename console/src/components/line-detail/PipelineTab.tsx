import React, { useState } from 'react'
import { Button } from '../primitives/Button'
import { formatCount } from '../../lib/text-utils'
import { formatRelative } from '../../lib/format-time'
import type { Mode, LineInstance } from './types'

/* Pipeline Node — compact inline pill */
function PipelineNode({
  label,
  value,
  color,
  active,
  selected,
  onClick,
}: {
  label: string
  value?: string
  color: string
  active?: boolean
  selected?: boolean
  onClick?: () => void
}) {
  const modeKey = color === 'pas' ? 'pas' : color === 'cht' ? 'cht' : 'agt'
  const pillStyle = {
    padding: onClick ? 'var(--sp-0h) var(--sp-3)' : 'var(--pipeline-node-pad-y) var(--sp-3)',
    borderRadius: 'var(--radius-sm)',
    background: active ? `var(--m-${modeKey}-wash)` : 'var(--btn-neutral-bg)',
    color: active ? `var(--color-m-${modeKey})` : 'var(--text-2)',
    border: selected
      ? `2px solid var(--color-m-${modeKey})`
      : active
        ? `var(--bw) solid var(--m-${modeKey}-soft)`
        : 'var(--bw) solid transparent',
  } satisfies React.CSSProperties

  if (onClick) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={onClick}
        className="font-mono inline-flex items-center gap-1.5 text-data"
        style={pillStyle}
      >
        <span>{label}</span>
        {value && (
          <span className="font-mono text-text-2 text-xs">
            {value}
          </span>
        )}
      </Button>
    )
  }

  return (
    <span
      className="inline-flex items-center gap-1.5"
    >
      <span
        className="font-mono font-medium text-data"
        style={pillStyle}
      >
        {label}
      </span>
      {value && (
        <span className="font-mono text-text-2 text-xs">
          {value}
        </span>
      )}
    </span>
  )
}

function PipelineArrow() {
  return <span className="text-text-3 font-mono flex-shrink-0 text-sm">→</span>
}

export { PipelineNode, PipelineArrow }

function getNodeDetails(
  nodeLabel: string,
  _mode: Mode,
  line: LineInstance,
): { label: string; value: string }[] | null {
  const details: { label: string; value: string }[] = []

  switch (nodeLabel) {
    case 'Inbound':
      details.push({ label: 'Status', value: line.status })
      if (line.messagesToday != null) details.push({ label: 'Messages today', value: String(line.messagesToday) })
      if (line.metricAvailability?.messageStats === 'unavailable') {
        details.push({ label: 'Received', value: '-' })
        details.push({ label: 'Sent', value: '-' })
      } else if (line.messageStats) {
        details.push({ label: 'Received', value: String(line.messageStats.received) })
        details.push({ label: 'Sent', value: String(line.messageStats.sent) })
      }
      break
    case 'Queue':
      details.push({ label: 'Queue depth', value: String(line.queueDepth ?? 0) })
      break
    case 'Enrich':
      details.push({ label: 'Unprocessed', value: String(line.enrichmentUnprocessed ?? 0) })
      break
    case 'Access':
      details.push({ label: 'Access mode', value: line.accessMode })
      break
    case 'API':
      if (line.models?.conversation) details.push({ label: 'Model', value: line.models.conversation })
      if (line.tokenUsage) {
        details.push({ label: 'Input tokens', value: formatCount(line.tokenUsage.input) })
        details.push({ label: 'Output tokens', value: formatCount(line.tokenUsage.output) })
      }
      break
    case 'SDK Loop':
      details.push({ label: 'Active sessions', value: String(line.activeSessions ?? 0) })
      if (line.lastSessionStatus) details.push({ label: 'Last session', value: line.lastSessionStatus })
      if (line.totalSessions != null) details.push({ label: 'Total sessions', value: String(line.totalSessions) })
      break
    case 'Tools':
      if (line.models?.conversation) details.push({ label: 'Model', value: line.models.conversation })
      if (line.sandboxPerChat != null) details.push({ label: 'Sandbox per chat', value: String(line.sandboxPerChat) })
      break
    case 'Store':
      if (line.health?.sqlite) {
        details.push({ label: 'Messages stored', value: String(line.health.sqlite.messages_total) })
        details.push({ label: 'Schema version', value: String(line.health.sqlite.schema_version) })
      }
      break
    case 'Router':
      details.push({ label: 'Access mode', value: line.accessMode })
      if (line.chatCounts) {
        details.push({ label: 'Chats', value: String(line.chatCounts.chats) })
        details.push({ label: 'Groups', value: String(line.chatCounts.groups) })
      }
      break
    case 'Outbound':
      details.push({ label: 'Status', value: line.status })
      break
    default:
      return null
  }

  return details.length > 0 ? details : null
}

function NodeDetailCard({
  details,
  modeColor,
}: {
  details: { label: string; value: string }[]
  modeColor: string
}) {
  const modeKey = modeColor === 'pas' ? 'pas' : modeColor === 'cht' ? 'cht' : 'agt'
  return (
    <div
      className="mt-[var(--sp-3)] py-[var(--sp-3)] px-[var(--sp-4)] bg-surface-inset rounded-md"
      style={{
        borderWidth: 'var(--bw)',
        borderStyle: 'solid',
        borderColor: `var(--m-${modeKey}-soft)`,
      }}
    >
      <div
        className="grid gap-x-[var(--sp-3)] gap-y-[var(--sp-1)]"
        style={{
          gridTemplateColumns: 'auto 1fr',
        }}
      >
        {details.map((d) => (
          <React.Fragment key={d.label}>
            <span
              className="font-mono text-text-2 text-data"
            >
              {d.label}
            </span>
            <span
              className="font-mono text-text-2 text-data"
            >
              {d.value}
            </span>
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}

export function PipelineTab({ mode, line, modeColor }: { mode: Mode; line: LineInstance; modeColor: string }) {
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const isOnline = line.status === 'online'

  // GUI-5: pipeline telemetry reflects the same fleet health snapshot — when it
  // is carried forward, label it (never silently green). Mirrors SoupKitchen.
  const freshnessNote = (line.stale || line.healthObservedAt) && (
    <div>
      <span
        className={`c-label${line.stale ? ' text-s-warn' : ''}`}
        title={
          line.stale
            ? (line.healthObservedAt
                ? `Pipeline telemetry carried forward — last live poll ${formatRelative(line.healthObservedAt)}`
                : 'Pipeline telemetry is stale — the poller is currently failing')
            : `Last live health poll ${formatRelative(line.healthObservedAt)}`
        }
      >
        {line.stale
          ? `stale · ${line.healthObservedAt ? formatRelative(line.healthObservedAt) : 'unknown'}`
          : `observed ${formatRelative(line.healthObservedAt)}`}
      </span>
    </div>
  )

  const toggleNode = (label: string) => {
    setSelectedNode((prev) => (prev === label ? null : label))
  }

  const details = selectedNode ? getNodeDetails(selectedNode, mode, line) : null

  if (mode === 'passive') {
    return (
      <div className="c-section">
        {freshnessNote}
        <div className="flex items-center justify-center gap-2 py-12">
          <PipelineNode label="Inbound" color={modeColor} active={isOnline} selected={selectedNode === 'Inbound'} onClick={() => toggleNode('Inbound')} />
          <PipelineArrow />
          <PipelineNode label="Store" color={modeColor} active={isOnline} selected={selectedNode === 'Store'} onClick={() => toggleNode('Store')} />
          <PipelineArrow />
          <PipelineNode label="Done" color={modeColor} active={isOnline && (line.unread ?? 0) === 0} />
        </div>
        {details && <NodeDetailCard details={details} modeColor={modeColor} />}
      </div>
    )
  }

  if (mode === 'chat') {
    const queueDepth = line.queueDepth ?? 0
    const enrichUnproc = line.enrichmentUnprocessed ?? 0
    return (
      <div className="c-section">
        {freshnessNote}
        <div className="flex items-center justify-center gap-2 py-12 flex-wrap">
          <PipelineNode label="Inbound" color={modeColor} active={isOnline} selected={selectedNode === 'Inbound'} onClick={() => toggleNode('Inbound')} />
          <PipelineArrow />
          <PipelineNode label="Access" color={modeColor} active={isOnline && line.accessMode !== 'self_only'} selected={selectedNode === 'Access'} onClick={() => toggleNode('Access')} />
          <PipelineArrow />
          <PipelineNode label="Queue" value={`depth: ${queueDepth}`} color={modeColor} active={queueDepth > 0} selected={selectedNode === 'Queue'} onClick={() => toggleNode('Queue')} />
          <PipelineArrow />
          <PipelineNode label="Enrich" value={enrichUnproc > 0 ? `${enrichUnproc} pending` : undefined} color={modeColor} active={enrichUnproc > 0} selected={selectedNode === 'Enrich'} onClick={() => toggleNode('Enrich')} />
          <PipelineArrow />
          <PipelineNode label="API" color={modeColor} active={isOnline} selected={selectedNode === 'API'} onClick={() => toggleNode('API')} />
          <PipelineArrow />
          <PipelineNode label="Outbound" color={modeColor} active={queueDepth > 0} selected={selectedNode === 'Outbound'} onClick={() => toggleNode('Outbound')} />
        </div>
        {details && <NodeDetailCard details={details} modeColor={modeColor} />}
      </div>
    )
  }

  // Agent mode
  const sessions = line.activeSessions ?? 0
  return (
    <div className="c-section">
        {freshnessNote}
      <div className="flex items-center justify-center gap-2 py-12 flex-wrap">
        <PipelineNode label="Inbound" color={modeColor} active={isOnline} selected={selectedNode === 'Inbound'} onClick={() => toggleNode('Inbound')} />
        <PipelineArrow />
        <PipelineNode label="Router" color={modeColor} active={isOnline} selected={selectedNode === 'Router'} onClick={() => toggleNode('Router')} />
        <PipelineArrow />
        <PipelineNode label="SDK Loop" value={`sessions: ${sessions}`} color={modeColor} active={sessions > 0} selected={selectedNode === 'SDK Loop'} onClick={() => toggleNode('SDK Loop')} />
        <PipelineArrow />
        <PipelineNode label="Tools" color={modeColor} active={sessions > 0} selected={selectedNode === 'Tools'} onClick={() => toggleNode('Tools')} />
        <PipelineArrow />
        <PipelineNode label="Outbound" color={modeColor} active={sessions > 0} selected={selectedNode === 'Outbound'} onClick={() => toggleNode('Outbound')} />
      </div>
      {details && <NodeDetailCard details={details} modeColor={modeColor} />}
    </div>
  )
}
