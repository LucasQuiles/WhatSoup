import { useState, useMemo, useCallback, lazy, Suspense } from 'react'
import { motion } from 'framer-motion'
import { useLines, useLogs, useFeed } from '../hooks/use-fleet'
import { formatTimeWithSeconds } from '../lib/format-time'
import StatusDot from '../components/StatusDot'
import ModeBadge from '../components/ModeBadge'
import LineTags from '../components/LineTags'
import HeartbeatStrip from '../components/HeartbeatStrip'
import LinePicker from '../components/LinePicker'
import { LogStream, Toolbar, ToolbarFilters, Pill, Button } from '../components/primitives'
import type { LogEntry } from '../types'
import {
  Terminal, Power,
  AlertTriangle, CheckCircle2,
  Trash2, Link2, Loader2,
} from 'lucide-react'

import { api } from '../lib/api'
import { useToast } from '../hooks/toast-context'
import { useQueryClient } from '@tanstack/react-query'
import { displayInstanceName } from '../lib/text-utils'
import { statusWashClass } from '../lib/status-severity'
import ConfirmDialog from '../components/ConfirmDialog'
const RelinkModal = lazy(() => import('../components/RelinkModal'))

type LevelFilter = 'all' | 'error' | 'warn' | 'info' | 'debug'

const LOG_LEVELS: LevelFilter[] = ['all', 'error', 'warn', 'info', 'debug']

function logLevelTone(level: LevelFilter) {
  if (level === 'error') return 'crit' as const
  if (level === 'warn') return 'warn' as const
  return 'neutral' as const
}

export default function Ops() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [relinkTarget, setRelinkTarget] = useState<string | null>(null)
  const { data: lines = [], isLoading: linesLoading } = useLines()
  const { data: feed = [] } = useFeed()
  const [logFilter, setLogFilter] = useState<LevelFilter>('all')
  const [selectedLine, setSelectedLine] = useState<string>('')

  const activeLine = selectedLine || (lines[0]?.name ?? '')
  const { data: logs = [] } = useLogs(activeLine)
  const currentLine = lines.find(l => l.name === activeLine)

  // Pre-format timestamps so LogStream renders human-readable times.
  const formattedLogs = useMemo(
    () => logs.map((e: LogEntry) => ({ ...e, timestamp: formatTimeWithSeconds(e.timestamp) })),
    [logs],
  )

  const filteredLogs = useMemo(() => {
    if (logFilter === 'all') return formattedLogs
    return formattedLogs.filter(e => e.level === logFilter)
  }, [formattedLogs, logFilter])

  // Level counts sourced from the full (unfiltered) log list.
  const logCounts = useMemo(() => {
    const acc: Record<string, number> = { error: 0, warn: 0, info: 0, debug: 0 }
    for (const e of logs) acc[e.level] = (acc[e.level] ?? 0) + 1
    return acc
  }, [logs])

  const alerts = useMemo(() => feed.filter(e => e.isError), [feed])

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api.deleteLine(deleteTarget)
      toast.success(`${deleteTarget} deleted`)
      queryClient.invalidateQueries({ queryKey: ['lines'] })
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setDeleting(false)
      setDeleteTarget(null)
    }
  }, [deleteTarget, toast, queryClient])

  const ease = [0.22, 1, 0.36, 1] as const

  return (
    <motion.div
      className="flex-1 flex min-h-0 overflow-hidden p-[var(--sp-4)] gap-[var(--sp-3)]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, ease }}
    >

      {/* ═══ LEFT: Fleet Status (swapped from right) ═══ */}
      <div
        className="c-card flex flex-col min-h-0 overflow-hidden flex-1"
      >
        {/* Row 1: Header — matches toolbar pattern */}
        <div
          className="flex items-center justify-between flex-shrink-0 bg-d3 c-toolbar c-border-b min-h-[var(--toolbar-h)]"
        >
          <span className="c-heading">Fleet Status</span>
          {alerts.length > 0 ? (
            <span className="flex items-center font-mono text-s-crit gap-[var(--sp-1)] text-label">
              <AlertTriangle size={12} strokeWidth={1.75} />
              {alerts.length} alert{alerts.length !== 1 ? 's' : ''}
            </span>
          ) : (
            <span className="flex items-center font-mono text-s-ok gap-[var(--sp-1)] text-label">
              <CheckCircle2 size={12} strokeWidth={1.75} />
              all healthy
            </span>
          )}
        </div>

        {/* Row 2: Summary stats — matches column header row */}
        <div
          className="flex items-center justify-between flex-shrink-0 c-cell c-border-b-b2"
        >
          <div className="flex items-center gap-[var(--sp-3)]">
            <span className="c-label">{lines.length} instances</span>
            <span className="c-label">{lines.filter(l => l.status === 'online').length} online</span>
            {alerts.length > 0 && (
              <span className="font-mono text-s-crit text-label">
                {alerts.length} unhealthy
              </span>
            )}
          </div>
        </div>

        {/* Instance cards */}
        <div className="flex-1 min-h-0 min-w-0 overflow-auto scrollbar-hide p-[var(--sp-3)]">
          <div className="flex flex-col gap-[var(--sp-2)]">
            {linesLoading ? (
              <div className="text-t5 text-center py-8 font-mono text-data">
                Loading fleet status...
              </div>
            ) : lines.length === 0 ? (
              <div className="text-t5 text-center py-8 font-mono text-data">
                No instances discovered. Create one from the Soup Kitchen.
              </div>
            ) : lines.map(line => (
              <div
                key={line.name}
                className={`c-card c-hover cursor-pointer py-[var(--sp-3)] px-[var(--sp-4)] ${
                  line.name === activeLine ? 'ring-1 ring-m-cht/30' : ''
                } ${statusWashClass(line.status) || 'bg-d2'}`}
                onClick={() => setSelectedLine(line.name)}
              >
                {/* Row 1: Name + mode + phone */}
                <div className="flex items-center justify-between mb-[var(--sp-2)]">
                  <div className="flex items-center gap-[var(--sp-2)]">
                    <StatusDot status={line.status} size="sm" />
                    <span className="font-sans font-medium text-t1 text-body">
                      {displayInstanceName(line.name)}
                    </span>
                    <ModeBadge mode={line.mode} />
                    <LineTags line={line} />
                  </div>
                  <span className="c-label">{line.phone}</span>
                </div>

                {/* Row 2: Heartbeat + runtime stats */}
                <div className="flex items-center justify-between">
                  <HeartbeatStrip beats={line.heartbeat} />
                  <div className="flex items-center font-mono text-t4 gap-[var(--sp-3)] text-sm">
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
                      <span style={{ color: "var(--text-2)" }}>
                        {line.activeSessions ?? 0} session{(line.activeSessions ?? 0) !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                </div>

                {/* Row 3: Actions for unhealthy lines */}
                {line.status !== 'online' && (
                  <div className="flex gap-[var(--sp-2)] mt-[var(--sp-3)] pt-[var(--sp-3)] c-border-t">
                    {line.linkedStatus === 'unlinked' ? (
                      <Button
                        variant="neutral"
                        className="py-[var(--sp-1)] px-[var(--sp-3)] text-label"
                        icon={<Link2 size={15} strokeWidth={1.75} />}
                        onClick={e => { e.stopPropagation(); setRelinkTarget(line.name) }}
                      >
                        Re-link
                      </Button>
                    ) : (
                      <Button
                        variant="neutral"
                        className="py-[var(--sp-1)] px-[var(--sp-3)] text-label"
                        icon={<Power size={15} strokeWidth={1.75} />}
                        onClick={e => {
                          e.stopPropagation()
                          toast.info(`Restarting ${line.name}...`)
                          api.restart(line.name)
                            .then(() => toast.success(`${line.name} restart requested`))
                            .catch(err => toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`))
                        }}
                      >
                        Restart
                      </Button>
                    )}
                    <Button
                      variant="danger"
                      className="py-[var(--sp-1)] px-[var(--sp-3)] text-label"
                      icon={<Trash2 size={15} strokeWidth={1.75} />}
                      onClick={e => { e.stopPropagation(); setDeleteTarget(line.name) }}
                    >
                      Delete
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

      </div>

      {/* ═══ RIGHT: Log stream (swapped from left) ═══ */}
      <div
        className="c-card flex flex-col min-h-0 overflow-hidden"
        style={{ flex: "1.6" }}
      >
        {/* Row 1: Line picker toolbar — not a Toolbar primitive; heading + picker stay here */}
        <div
          className="flex items-center justify-between flex-shrink-0 bg-d3 c-toolbar c-border-b min-h-[var(--toolbar-h)]"
        >
          <div className="flex items-center gap-[var(--sp-3)]">
            <Terminal size={15} strokeWidth={1.75} className="text-m-agt" />
            <LinePicker
              lines={lines}
              activeLine={activeLine}
              onSelect={setSelectedLine}
              variant="compact"
            />
          </div>

          <span className="c-heading">Logs</span>
        </div>

        {/* Row 2: Level filter toolbar — flush Toolbar fronting the LogStream */}
        <Toolbar flush aria-label="Log level filter">
          <ToolbarFilters label="Level">
            {LOG_LEVELS.map(l => (
              <Pill
                key={l}
                variant="interactive"
                tone={logLevelTone(l)}
                pressed={logFilter === l}
                onClick={() => setLogFilter(l)}
                count={l !== 'all' ? logCounts[l] : undefined}
              >
                {l}
              </Pill>
            ))}
          </ToolbarFilters>
          <span className="c-label">{filteredLogs.length} entries</span>
        </Toolbar>

        {/* Log stream */}
        <LogStream
          entries={filteredLogs}
          isFiltered={logFilter !== 'all'}
          filteredEmptyMessage={
            activeLine
              ? `No ${logFilter} logs for ${activeLine}.`
              : 'Select an instance to view logs.'
          }
          emptyMessage={
            activeLine
              ? `No logs for ${activeLine}.`
              : 'Select an instance to view logs.'
          }
        />

        {/* Status bar */}
        <div
          className="flex items-center justify-between flex-shrink-0 font-mono text-t5 py-[var(--sp-1h)] px-[var(--sp-4)] c-border-t bg-d1 text-xs"
        >
          <span>{filteredLogs.length} entries</span>
          <span>{activeLine} — {currentLine?.mode ?? '—'}</span>
        </div>
      </div>

      {/* Modals */}
      <ConfirmDialog
        open={!!deleteTarget}
        title={`Delete ${deleteTarget}?`}
        confirmLabel={deleting ? 'Deleting...' : 'Delete permanently'}
        confirmVariant="danger"
        confirmIcon={deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      >
        This will stop the process, remove all configuration, data, and message history for <strong>{deleteTarget}</strong>. This cannot be undone.
      </ConfirmDialog>

      <Suspense fallback={null}>
        <RelinkModal
          lineName={relinkTarget ?? ''}
          open={!!relinkTarget}
          onClose={() => setRelinkTarget(null)}
          onLinked={() => { setRelinkTarget(null); queryClient.invalidateQueries({ queryKey: ['lines'] }); toast.success('Instance re-linked!'); }}
        />
      </Suspense>
    </motion.div>
  )
}
