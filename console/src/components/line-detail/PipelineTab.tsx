import type { Mode, LineInstance } from './types'

/* Pipeline Node — compact inline pill */
function PipelineNode({ label, value, color, active }: { label: string; value?: string; color: string; active?: boolean }) {
  const modeKey = color === 'pas' ? 'pas' : color === 'cht' ? 'cht' : 'agt';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="font-mono font-medium"
        style={{
          padding: '5px var(--sp-3)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 'var(--font-size-label)',
          background: active ? `var(--m-${modeKey}-wash)` : 'var(--color-d4)',
          color: active ? `var(--color-m-${modeKey})` : 'var(--color-t3)',
          border: active ? `var(--bw) solid var(--m-${modeKey}-soft)` : 'var(--bw) solid transparent',
        }}
      >
        {label}
      </span>
      {value && (
        <span className="font-mono text-t4" style={{ fontSize: 'var(--font-size-xs)' }}>
          {value}
        </span>
      )}
    </span>
  )
}

function PipelineArrow() {
  return <span className="text-t5 font-mono flex-shrink-0" style={{ fontSize: 'var(--font-size-sm)' }}>→</span>
}

export { PipelineNode, PipelineArrow }

export function PipelineTab({ mode, line, modeColor }: { mode: Mode; line: LineInstance; modeColor: string }) {
  const isOnline = line.status === 'online'
  if (mode === 'passive') {
    return (
      <div
        style={{ borderRadius: 'var(--radius-lg)', background: 'var(--color-d2)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)', padding: 'var(--sp-7)' }}
      >
        <div className="flex items-center justify-center gap-2 py-12">
          <PipelineNode label="Inbound" color={modeColor} active={isOnline} />
          <PipelineArrow />
          <PipelineNode label="Store" color={modeColor} active={isOnline} />
          <PipelineArrow />
          <PipelineNode label="Done" color={modeColor} active={isOnline && (line.unread ?? 0) === 0} />
        </div>
      </div>
    )
  }
  if (mode === 'chat') {
    const queueDepth = line.queueDepth ?? 0
    const enrichUnproc = line.enrichmentUnprocessed ?? 0
    return (
      <div
        style={{ borderRadius: 'var(--radius-lg)', background: 'var(--color-d2)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)', padding: 'var(--sp-7)' }}
      >
        <div className="flex items-center justify-center gap-2 py-12 flex-wrap">
          <PipelineNode label="Inbound" color={modeColor} active={isOnline} />
          <PipelineArrow />
          <PipelineNode label="Access" color={modeColor} active={isOnline && line.accessMode !== 'self_only'} />
          <PipelineArrow />
          <PipelineNode label="Queue" value={`depth: ${queueDepth}`} color={modeColor} active={queueDepth > 0} />
          <PipelineArrow />
          <PipelineNode label="Enrich" value={enrichUnproc > 0 ? `${enrichUnproc} pending` : undefined} color={modeColor} active={enrichUnproc > 0} />
          <PipelineArrow />
          <PipelineNode label="API" color={modeColor} active={isOnline} />
          <PipelineArrow />
          <PipelineNode label="Outbound" color={modeColor} active={queueDepth > 0} />
        </div>
      </div>
    )
  }
  const sessions = line.activeSessions ?? 0
  return (
    <div
      style={{ borderRadius: 'var(--radius-lg)', background: 'var(--color-d2)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)', padding: 'var(--sp-7)' }}
    >
      <div className="flex items-center justify-center gap-2 py-12 flex-wrap">
        <PipelineNode label="Inbound" color={modeColor} active={isOnline} />
        <PipelineArrow />
        <PipelineNode label="Router" color={modeColor} active={isOnline} />
        <PipelineArrow />
        <PipelineNode label="SDK Loop" value={`sessions: ${sessions}`} color={modeColor} active={sessions > 0} />
        <PipelineArrow />
        <PipelineNode label="Tools" color={modeColor} active={sessions > 0} />
        <PipelineArrow />
        <PipelineNode label="Outbound" color={modeColor} active={sessions > 0} />
      </div>
    </div>
  )
}
