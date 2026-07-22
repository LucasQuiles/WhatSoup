import { useState, useMemo, lazy, Suspense } from 'react'
import { motion } from 'framer-motion'
import { useLines, useLogs, useFeed } from '../hooks/use-fleet'
import { formatTimeWithSeconds } from '../lib/format-time'
import StatusDot from '../components/StatusDot'
import ModeBadge from '../components/ModeBadge'
import LineTags from '../components/LineTags'
import HeartbeatStrip from '../components/HeartbeatStrip'
import LinePicker from '../components/LinePicker'
import FleetRowMenu from '../components/FleetRowMenu'
import { Card, LogStream, Toolbar, ToolbarFilters, Pill, Button, type CardEdge } from '../components/primitives'
import type { LogEntry } from '../types'
import {
  Terminal,
  AlertTriangle, CheckCircle2,
  Link2, RotateCw,
} from 'lucide-react'

import { useToast } from '../hooks/toast-context'
import { useQueryClient } from '@tanstack/react-query'
import { displayInstanceName } from '../lib/text-utils'
import { statusWashClass, statusSeverity } from '../lib/status-severity'
import { computeKpis } from '../lib/compute-kpis'
const RelinkModal = lazy(() => import('../components/RelinkModal'))

type LevelFilter = 'all' | 'error' | 'warn' | 'info' | 'debug'

const LOG_LEVELS: LevelFilter[] = ['all', 'error', 'warn', 'info', 'debug']

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function logLevelTone(level: LevelFilter) {
  if (level === 'error') return 'crit' as const
  if (level === 'warn') return 'warn' as const
  return 'neutral' as const
}

// status-edge channel for a line card: online lines carry no edge (the card stays
// neutral); non-online lines surface a warn/crit inset channel keyed to severity.
// This is an ADDITIONAL signal alongside the StatusDot + status text + wash — never
// the sole one (color.md §6).
function lineCardEdge(status: string): CardEdge | undefined {
  const severity = statusSeverity(status)
  return severity === 'ok' ? undefined : severity
}

export default function Operator() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [relinkTarget, setRelinkTarget] = useState<string | null>(null)
  // Capability gate for per-line lifecycle actions (Restart / Stop / Delete),
  // mirroring SoupKitchen.tsx: the console is already gated behind the
  // session-unlock screen, so any reachable operator may manage lines. Surfaced
  // as one boolean so the FleetRowMenu hides wholesale when withheld and the gate
  // has one obvious place to tighten.
  const canManageLines = true
  const { data: lines = [], isLoading: linesLoading, error: linesError, refetch: refetchLines } = useLines()
  const { data: feed = [], error: feedError, refetch: refetchFeed } = useFeed()
  const [logFilter, setLogFilter] = useState<LevelFilter>('all')
  const [selectedLine, setSelectedLine] = useState<string>('')

  const activeLine = selectedLine || (lines[0]?.name ?? '')
  const { data: logs = [], error: logsError, refetch: refetchLogs } = useLogs(activeLine)
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

  // Historical activity-feed alerts (#1882 criterion 2): warning/error log
  // lines the feed parsed, kept SEPARATE from the current-health headline
  // below. These are useful as a recent-activity trail — but a line can
  // recover while an old error entry still lingers here, or degrade before
  // anything reaches the feed — so this count must never be relabeled as
  // "current unhealthy lines".
  const feedAlerts = useMemo(() => feed.filter(e => e.isError), [feed])

  // Current-line-health headline (#1882 criterion 1): reuses the SAME
  // computeKpis the Fleet page KPI strip reads (#1881), so "unhealthy" and
  // the stale/unknown coverage can't drift into a second, disagreeing
  // definition of "healthy". needAttention is status-derived (always live —
  // #1762 rem-1 keeps status visible through an outage); connectivityUnknown
  // flags lines whose transport state couldn't be confirmed this poll.
  // connectivityUnknown is 0 whenever needAttention is 0 (isLineConnectivityUnknown
  // only fires for a non-online status), but both are checked explicitly so the
  // green state can never mask an unresolved coverage gap.
  const kpis = useMemo(() => computeKpis(lines), [lines])
  const isHealthy = kpis.needAttention === 0 && kpis.connectivityUnknown === 0

  const ease = [0.22, 1, 0.36, 1] as const

  return (
    <motion.div
      className="soup-operator-layout flex-1 flex min-h-0 overflow-hidden p-[var(--sp-4)] gap-[var(--sp-3)]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, ease }}
    >

      {/* ═══ LEFT: Fleet Status (swapped from right) ═══ */}
      <Card
        variant="base"
        className="flex flex-col min-h-0 overflow-hidden flex-1"
      >
        {/* Row 1: Header — matches toolbar pattern */}
        <div
          className="flex items-center justify-between flex-shrink-0 bg-surface-raised c-toolbar c-border-b min-h-[var(--toolbar-h)]"
        >
          <span className="c-heading">Fleet Status</span>
          <div className="flex items-center gap-[var(--sp-3)]">
            {isHealthy ? (
              <span className="flex items-center font-mono text-s-ok gap-[var(--sp-1)] text-label">
                <CheckCircle2 size={12} strokeWidth={1.75} />
                all healthy
              </span>
            ) : (
              <span className="flex items-center font-mono text-s-crit gap-[var(--sp-1)] text-label">
                <AlertTriangle size={12} strokeWidth={1.75} />
                {kpis.needAttention > 0 && <span>{kpis.needAttention} unhealthy</span>}
                {kpis.connectivityUnknown > 0 && <span>{kpis.connectivityUnknown} unknown</span>}
              </span>
            )}
            {feedError && (
              <span className="flex items-center font-mono text-s-crit gap-[var(--sp-1)] text-label">
                <AlertTriangle size={12} strokeWidth={1.75} />
                alerts unavailable
              </span>
            )}
          </div>
        </div>

        {/* Row 2: Summary stats — matches column header row */}
        <div
          className="flex items-center justify-between flex-shrink-0 c-cell c-border-b-b2"
        >
          <div className="flex items-center gap-[var(--sp-3)]">
            <span className="c-label">{lines.length} Lines</span>
            <span className="c-label">{lines.filter(l => l.status === 'online').length} online</span>
            {feedAlerts.length > 0 && (
              <span className="font-mono text-s-warn text-label">
                {feedAlerts.length} feed alert{feedAlerts.length !== 1 ? 's' : ''}
              </span>
            )}
            {feedError && (
              <span className="font-mono text-s-crit text-label">
                Activity feed unavailable: {errorMessage(feedError)}
              </span>
            )}
          </div>
          {feedError && (
            <Button
              variant="neutral"
              size="sm"
              icon={<RotateCw size={12} strokeWidth={1.75} />}
              onClick={() => { void refetchFeed() }}
            >
              Retry alerts
            </Button>
          )}
        </div>

        {/* Instance cards */}
        <div className="flex-1 min-h-0 min-w-0 overflow-auto scrollbar-hide p-[var(--sp-3)]">
          <div className="flex flex-col gap-[var(--sp-2)]">
            {linesLoading ? (
              <div className="text-text-2 text-center py-8 font-mono text-data">
                Loading fleet status...
              </div>
            ) : linesError ? (
              <div className="flex flex-col items-center justify-center gap-[var(--sp-3)] text-center py-8 px-[var(--sp-4)]">
                <span className="font-mono text-s-crit text-data">
                  Failed to load fleet status: {errorMessage(linesError)}
                </span>
                <Button
                  variant="neutral"
                  size="sm"
                  icon={<RotateCw size={12} strokeWidth={1.75} />}
                  onClick={() => { void refetchLines() }}
                >
                  Retry fleet status
                </Button>
              </div>
            ) : lines.length === 0 ? (
              <div className="text-text-2 text-center py-8 font-mono text-data">
                No Lines discovered. Create one from the Fleet.
              </div>
            ) : lines.map(line => {
              const isActive = line.name === activeLine
              const isUnlinked = line.linkedStatus === 'unlinked'
              const edge = lineCardEdge(line.status)
              // status-edge channel applied via the SAME tokens the Card primitive's
              // status-edge variant uses (a --bw-accent inset left border keyed to the
              // status-solid token). The interactive Card can't take the `edge` prop
              // (status-edge and interactive are distinct variants), so the channel is
              // composed here — it remains an ADDITIONAL signal alongside the wash +
              // StatusDot shape, never the sole one (color.md §6).
              const edgeStyle = edge
                ? {
                    borderLeftStyle: 'solid' as const,
                    borderLeftWidth: 'var(--bw-accent)',
                    borderLeftColor:
                      edge === 'crit' ? 'var(--status-crit-solid)' : 'var(--status-warn-solid)',
                  }
                : undefined
              return (
                // A plain relative LAYOUT wrapper (not a card, not interactive): it lets
                // the kebab cluster sit as a SIBLING of the selection card, so the
                // FleetRowMenu's own <button> is never nested inside the selection
                // <button> (button-in-button is invalid HTML).
                <div key={line.name} className="relative">
                  {/* Top-right action cluster — sibling of the selection card. */}
                  <div className="absolute top-[var(--sp-2)] right-[var(--sp-3)] flex items-center gap-[var(--sp-1)] z-[var(--z-float)]">
                    {isUnlinked && (
                      <Button
                        variant="neutral"
                        size="sm"
                        icon={<Link2 size={15} strokeWidth={1.75} />}
                        onClick={() => setRelinkTarget(line.name)}
                      >
                        Re-link
                      </Button>
                    )}
                    <FleetRowMenu name={line.name} canAct={canManageLines} />
                  </div>

                  {/* Selection affordance — the sanctioned interactive Card (renders a
                      real <button> through the primitive, so no raw <button>). Sets the
                      active line for the log stream; aria-pressed mirrors the selection. */}
                  <Card
                    variant="interactive"
                    aria-label={`Select ${displayInstanceName(line.name)}`}
                    aria-pressed={isActive}
                    onClick={() => setSelectedLine(line.name)}
                    style={edgeStyle}
                    className={`py-[var(--sp-3)] px-[var(--sp-4)] ${
                      isActive ? 'ring-1 ring-m-cht/30' : ''
                    } ${statusWashClass(line.status) || 'bg-surface-raised'}`}
                  >
                    {/* Row 1: Name + mode + phone */}
                    <div className="flex items-center justify-between mb-[var(--sp-2)] pr-[var(--sp-8)]">
                      <div className="flex items-center gap-[var(--sp-2)]">
                        <StatusDot status={line.status} />
                        <span className="font-sans font-medium text-text-1 text-body">
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
                      <div className="flex items-center font-mono text-text-2 gap-[var(--sp-3)] text-sm">
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
                  </Card>
                </div>
              )
            })}
          </div>
        </div>

      </Card>

      {/* ═══ RIGHT: Log stream (swapped from left) ═══ */}
      <Card
        variant="base"
        className="flex flex-col min-h-0 overflow-hidden"
        style={{ flex: "1.6" }}
      >
        {/* Row 1: Line picker toolbar — not a Toolbar primitive; heading + picker stay here */}
        <div
          className="flex items-center justify-between flex-shrink-0 bg-surface-raised c-toolbar c-border-b min-h-[var(--toolbar-h)]"
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
          error={logsError ? `Failed to load logs: ${errorMessage(logsError)}` : undefined}
          onRetry={logsError ? () => { void refetchLogs() } : undefined}
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
          className="flex items-center justify-between flex-shrink-0 font-mono text-text-3 py-[var(--sp-1h)] px-[var(--sp-4)] c-border-t bg-surface-inset text-xs"
        >
          <span>{filteredLogs.length} entries</span>
          <span>{activeLine} — {currentLine?.mode ?? '—'}</span>
        </div>
      </Card>

      {/* Modals */}
      <Suspense fallback={null}>
        <RelinkModal
          lineName={lines.find(line => line.name === relinkTarget)?.name ?? ''}
          transport={lines.find(line => line.name === relinkTarget)?.transport}
          open={lines.some(line => line.name === relinkTarget)}
          onClose={() => setRelinkTarget(null)}
          onLinked={() => { setRelinkTarget(null); queryClient.invalidateQueries({ queryKey: ['lines'] }); toast.success('Instance re-linked!'); }}
        />
      </Suspense>
    </motion.div>
  )
}
