import { levelColor, levelBg, levelLineBg } from '../../lib/log-theme'
import { formatTime } from '../../lib/format-time'
import FilterPill from '../FilterPill'
import type { LogEntry } from './types'

export function LogsTab({ logs, filter, onFilterChange }: { logs: LogEntry[]; filter: string; onFilterChange: (f: string) => void }) {
  const levels = ['all', 'info', 'warn', 'error', 'debug']

  const filtered = filter === 'all' ? logs : logs.filter(l => l.level === filter)

  return (
    <div
      className="overflow-hidden"
      style={{ borderRadius: 'var(--radius-lg)', background: 'var(--color-d2)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)' }}
    >
      {/* Toolbar with level filter pills */}
      <div
        className="flex items-center justify-between flex-shrink-0 bg-d3 c-toolbar"
        style={{ borderBottom: 'var(--bw) solid var(--b1)', minHeight: 'var(--toolbar-h)' }}
      >
        <span className="c-heading">Logs</span>
        <div className="flex" style={{ gap: 'var(--sp-1)' }}>
          {levels.map(l => (
            <FilterPill
              key={l}
              label={l}
              isActive={filter === l}
              activeColor={l === 'error' ? 'text-s-crit' : l === 'warn' ? 'text-s-warn' : 'text-t2'}
              activeBorder={filter === l ? 'var(--bw) solid var(--b3)' : undefined}
              onClick={() => onFilterChange(l)}
            />
          ))}
        </div>
      </div>

      {/* Log viewer */}
      <div
        className="c-card overflow-hidden font-mono"
        style={{ background: 'var(--color-d1)', fontSize: 'var(--font-size-data)' }}
      >
        {filtered.map((log, i) => (
          <div
            key={`${log.timestamp}-${log.source}-${i}`}
            className="flex gap-0 c-row-hover leading-relaxed"
            style={{
              borderBottom: 'var(--bw) solid var(--b1)',
              background: levelLineBg[log.level],
            }}
          >
            {/* Timestamp */}
            <div className="px-3 py-1 text-t5 flex-shrink-0" style={{ width: 'var(--log-col-time)', minWidth: 'var(--log-col-time)' }}>
              {formatTime(log.timestamp)}
            </div>
            {/* Level badge */}
            <div className="px-2 py-1 flex-shrink-0 text-center" style={{ width: 'var(--log-col-level)', minWidth: 'var(--log-col-level)' }}>
              <span
                className={`inline-block px-1.5 py-0.5 rounded font-medium ${levelColor[log.level]}`}
                style={{ fontSize: 'var(--font-size-sm)', background: levelBg[log.level] }}
              >
                {log.level}
              </span>
            </div>
            {/* Source */}
            <div
              className="px-2 py-1 text-t5 truncate flex-shrink-0"
              style={{ width: 'var(--log-col-source)', minWidth: 'var(--log-col-source)' }}
            >
              {log.source}
            </div>
            {/* Message */}
            <div className={`px-3 py-1 flex-1 ${levelColor[log.level]}`}>
              {log.msg}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
