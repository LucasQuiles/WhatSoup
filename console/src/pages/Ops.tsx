import { useState, useMemo } from 'react'
import { useLines, useLogs, useFeed } from '../hooks/use-fleet'
import StatusDot from '../components/StatusDot'
import ModeBadge from '../components/ModeBadge'
import HeartbeatStrip from '../components/HeartbeatStrip'
import type { LogEntry } from '../mock-data'
import {
  Terminal, ChevronDown, RefreshCw, Power,
  AlertTriangle, CheckCircle2,
} from 'lucide-react'

const levelColor: Record<string, string> = {
  info: 'text-t3',
  warn: 'text-s-warn',
  error: 'text-s-crit',
  debug: 'text-t5',
}
const levelBg: Record<string, string> = {
  info: 'var(--color-d5)',
  warn: 'var(--s-warn-wash)',
  error: 'var(--s-crit-soft)',
  debug: 'var(--color-d4)',
}

export default function Ops() {
  const { data: lines = [] } = useLines()
  const { data: feed = [] } = useFeed()
  const [logFilter, setLogFilter] = useState<string>('all')
  const [selectedLine, setSelectedLine] = useState<string>('')
  const [linePickerOpen, setLinePickerOpen] = useState(false)

  // Default to first line
  const activeLine = selectedLine || (lines[0]?.name ?? '')
  const { data: logs = [] } = useLogs(activeLine)

  const currentLine = lines.find(l => l.name === activeLine)

  const filteredLogs = useMemo(() => {
    if (logFilter === 'all') return logs
    return logs.filter(l => l.level === logFilter)
  }, [logs, logFilter])

  // Alerts from feed
  const alerts = useMemo(() => feed.filter(e => e.isError), [feed])

  return (
    <div className="flex-1 flex" style={{ height: 'calc(100vh - 52px)', padding: '12px', gap: '8px' }}>
      {/* ── LEFT: Log stream ── */}
      <div
        className="flex flex-col min-h-0"
        style={{
          flex: 1.4,
          border: '1px solid var(--b1)',
          borderRadius: '10px',
          overflow: 'hidden',
        }}
      >
        {/* Line picker + level filter toolbar */}
        <div
          className="flex items-center justify-between px-4 py-2.5 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--b1)', background: 'var(--color-d3)' }}
        >
          {/* Line picker */}
          <div className="flex items-center gap-3">
            <Terminal size={15} strokeWidth={1.75} className="text-m-agt" />
            <div className="relative">
              <button
                onClick={() => setLinePickerOpen(!linePickerOpen)}
                className="flex items-center gap-2 px-3 py-1.5 rounded text-sm text-t1 hover:bg-d3 transition-colors"
                style={{ border: '1px solid var(--b2)' }}
              >
                {currentLine && <StatusDot status={currentLine.status} size="sm" />}
                <span className="font-mono text-xs font-medium">{activeLine || 'Select line'}</span>
                <ChevronDown size={12} className="text-t4" />
              </button>

              {linePickerOpen && (
                <div
                  className="absolute top-full left-0 mt-1 z-20 min-w-[200px] max-h-64 overflow-auto rounded-md"
                  style={{ background: 'var(--color-d6)', border: '1px solid var(--b2)' }}
                >
                  {lines.map(line => (
                    <button
                      key={line.name}
                      onClick={() => { setSelectedLine(line.name); setLinePickerOpen(false) }}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-d4 transition-colors ${
                        line.name === activeLine ? 'bg-d4 text-t1' : 'text-t3'
                      }`}
                    >
                      <StatusDot status={line.status} size="sm" />
                      <span className="font-mono text-xs">{line.name}</span>
                      <ModeBadge mode={line.mode} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Level filter pills */}
          <div className="flex gap-1">
            {['all', 'error', 'warn', 'info', 'debug'].map(l => (
              <button
                key={l}
                onClick={() => setLogFilter(l)}
                className={`px-2.5 py-1 rounded font-mono transition-colors ${
                  logFilter === l ? 'text-t1 bg-d5' : 'text-t5 hover:text-t3'
                }`}
                style={{
                  fontSize: '0.65rem',
                  border: `1px solid ${logFilter === l ? 'var(--b3)' : 'var(--b1)'}`,
                }}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        {/* Log stream */}
        <div className="flex-1 overflow-auto font-mono" style={{ background: 'var(--color-d0)', fontSize: '0.75rem' }}>
          {filteredLogs.length > 0 ? (
            filteredLogs.map((log: LogEntry, i: number) => (
              <div
                key={i}
                className="flex items-start hover:bg-d3 transition-colors"
                style={{ borderBottom: '1px solid var(--b1)' }}
              >
                {/* Timestamp */}
                <div
                  className="px-3 py-1 text-t5 flex-shrink-0"
                  style={{ width: '100px', borderRight: '1px solid var(--b1)' }}
                >
                  {log.timestamp.split('T')[1]?.replace('Z', '') || log.timestamp}
                </div>
                {/* Level badge */}
                <div
                  className="px-2 py-1 flex-shrink-0 text-center"
                  style={{ width: '52px', borderRight: '1px solid var(--b1)' }}
                >
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded font-medium ${levelColor[log.level]}`}
                    style={{ fontSize: '0.6rem', background: levelBg[log.level] }}
                  >
                    {log.level}
                  </span>
                </div>
                {/* Source */}
                <div
                  className="px-2 py-1 text-t5 truncate flex-shrink-0"
                  style={{ width: '110px', borderRight: '1px solid var(--b1)' }}
                >
                  {log.source}
                </div>
                {/* Message */}
                <div className={`px-3 py-1 flex-1 ${levelColor[log.level]}`}>
                  {log.msg}
                </div>
              </div>
            ))
          ) : (
            <div className="flex items-center justify-center py-20 text-t5 font-mono" style={{ fontSize: '0.8rem' }}>
              {activeLine
                ? `No ${logFilter === 'all' ? '' : logFilter + ' '}logs for ${activeLine}`
                : 'Select a line to view logs'}
            </div>
          )}
        </div>

        {/* Status bar */}
        <div
          className="flex items-center justify-between px-4 py-1.5 flex-shrink-0 font-mono text-t5"
          style={{ fontSize: '0.6rem', borderTop: '1px solid var(--b1)', background: 'var(--color-d1)' }}
        >
          <span>{filteredLogs.length} entries</span>
          <span>{activeLine} — {currentLine?.mode ?? '—'}</span>
        </div>
      </div>

      {/* ── RIGHT: Connection status + runtime state ── */}
      <div
        className="flex flex-col min-h-0 overflow-auto"
        style={{
          flex: 1,
          background: 'var(--color-d1)',
          border: '1px solid var(--b1)',
          borderRadius: '10px',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-3 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--b1)' }}
        >
          <span className="font-sans font-semibold text-t1" style={{ fontSize: '0.82rem' }}>
            Fleet Status
          </span>
          {alerts.length > 0 ? (
            <span className="flex items-center gap-1.5 font-mono text-s-crit" style={{ fontSize: '0.65rem' }}>
              <AlertTriangle size={12} strokeWidth={1.75} />
              {alerts.length} alert{alerts.length !== 1 ? 's' : ''}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 font-mono text-s-ok" style={{ fontSize: '0.65rem' }}>
              <CheckCircle2 size={12} strokeWidth={1.75} />
              all healthy
            </span>
          )}
        </div>

        {/* Instance cards */}
        <div className="flex-1 overflow-auto p-4 space-y-2">
          {lines.map(line => (
            <div
              key={line.name}
              className={`rounded-md p-4 transition-colors ${
                line.name === activeLine ? 'ring-1 ring-m-cht/30' : ''
              }`}
              style={{
                background: line.status === 'unreachable'
                  ? 'var(--s-crit-wash)'
                  : line.status === 'degraded'
                  ? 'var(--s-warn-wash)'
                  : 'var(--color-d2)',
                border: '1px solid var(--b1)',
                cursor: 'pointer',
              }}
              onClick={() => { setSelectedLine(line.name); setLinePickerOpen(false) }}
            >
              {/* Row 1: Name + mode + status */}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <StatusDot status={line.status} size="sm" />
                  <span className="font-sans font-medium text-t1" style={{ fontSize: '0.82rem' }}>
                    {line.name}
                  </span>
                  <ModeBadge mode={line.mode} />
                </div>
                <span className="font-mono text-t5" style={{ fontSize: '0.7rem' }}>
                  {line.phone}
                </span>
              </div>

              {/* Row 2: Heartbeat + runtime stats */}
              <div className="flex items-center justify-between">
                <HeartbeatStrip beats={line.heartbeat} />
                <div className="flex items-center gap-3 font-mono text-t4" style={{ fontSize: '0.7rem' }}>
                  <span>{line.messagesToday ?? 0} msgs</span>
                  {line.mode === 'passive' && (
                    <span className={(line.unread ?? 0) > 0 ? 'text-s-warn' : ''}>
                      {line.unread ?? 0} unread
                    </span>
                  )}
                  {line.mode === 'chat' && (
                    <>
                      <span className={(line.queueDepth ?? 0) > 0 ? 'text-s-warn' : ''}>
                        q:{line.queueDepth ?? 0}
                      </span>
                      <span>enrich:{line.enrichmentUnprocessed ?? 0}</span>
                    </>
                  )}
                  {line.mode === 'agent' && (
                    <span className="text-m-agt">
                      {line.activeSessions ?? 0} session{(line.activeSessions ?? 0) !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
              </div>

              {/* Row 3: Actions for unhealthy lines */}
              {line.status !== 'online' && (
                <div className="flex gap-2 mt-3 pt-3" style={{ borderTop: '1px solid var(--b1)' }}>
                  <button
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded font-mono text-t3 hover:text-t1 hover:bg-d5 transition-colors"
                    style={{ fontSize: '0.65rem', border: '1px solid var(--b2)' }}
                    onClick={e => e.stopPropagation()}
                  >
                    <RefreshCw size={11} strokeWidth={1.75} /> Reconnect
                  </button>
                  <button
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded font-mono text-s-crit hover:bg-d5 transition-colors"
                    style={{ fontSize: '0.65rem', border: '1px solid var(--b2)' }}
                    onClick={e => e.stopPropagation()}
                  >
                    <Power size={11} strokeWidth={1.75} /> Restart
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
