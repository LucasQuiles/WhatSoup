import { useMemo } from 'react'
import { formatTime } from '../../lib/format-time'
import { Card, LogStream, Toolbar, ToolbarFilters, Pill } from '../primitives'
import type { LogEntry } from './types'

type LevelFilter = 'all' | 'info' | 'warn' | 'error' | 'debug'

const LEVELS: LevelFilter[] = ['all', 'info', 'warn', 'error', 'debug']

function levelTone(level: LevelFilter) {
  if (level === 'error') return 'crit' as const
  if (level === 'warn') return 'warn' as const
  return 'neutral' as const
}

export function LogsTab({
  logs,
  filter,
  onFilterChange,
}: {
  logs: LogEntry[]
  filter: string
  onFilterChange: (f: string) => void
}) {
  // Pre-format timestamps so LogStream renders human-readable times.
  const formattedEntries = useMemo(
    () => logs.map(e => ({ ...e, timestamp: formatTime(e.timestamp) })),
    [logs],
  )

  const filteredEntries = useMemo(
    () =>
      filter === 'all'
        ? formattedEntries
        : formattedEntries.filter(e => e.level === filter),
    [formattedEntries, filter],
  )

  // Level counts sourced from the full (unfiltered) log list.
  const counts = useMemo(() => {
    const acc: Record<string, number> = { info: 0, warn: 0, error: 0, debug: 0 }
    for (const e of logs) acc[e.level] = (acc[e.level] ?? 0) + 1
    return acc
  }, [logs])

  return (
    <Card className="overflow-hidden flex flex-col">
      <Toolbar flush aria-label="Log level filter">
        <span className="c-heading">Logs</span>
        <ToolbarFilters label="Level">
          {LEVELS.map(l => (
            <Pill
              key={l}
              variant="interactive"
              tone={levelTone(l)}
              pressed={filter === l}
              onClick={() => onFilterChange(l)}
              count={l !== 'all' ? counts[l] : undefined}
            >
              {l}
            </Pill>
          ))}
        </ToolbarFilters>
      </Toolbar>

      <LogStream
        entries={filteredEntries}
        isFiltered={filter !== 'all'}
        filteredEmptyMessage={`No ${filter} logs.`}
      />
    </Card>
  )
}
