import { useState, useMemo, useCallback } from 'react'
import { motion } from 'framer-motion'
import { useLines, useLogs, useFeed } from '../hooks/use-fleet'
import { formatTimeWithSeconds } from '../lib/format-time'
import StatusDot from '../components/StatusDot'
import ModeBadge from '../components/ModeBadge'
import HeartbeatStrip from '../components/HeartbeatStrip'
import FilterPill from '../components/FilterPill'
import LinePicker from '../components/LinePicker'
import type { LogEntry } from '../types'
import {
  Terminal, Power,
  AlertTriangle, CheckCircle2,
  Trash2, Link2, Loader2,
} from 'lucide-react'

import { levelColor, levelBg } from '../lib/log-theme'
import { api } from '../lib/api'
import { useToast } from '../hooks/toast-context'
import { useQueryClient } from '@tanstack/react-query'
import { displayInstanceName } from '../lib/text-utils'
import ConfirmDialog from '../components/ConfirmDialog'
import RelinkModal from '../components/RelinkModal'

export default function Ops() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [relinkTarget, setRelinkTarget] = useState<string | null>(null)
  const { data: lines = [] } = useLines()
  const { data: feed = [] } = useFeed()
  const [logFilter, setLogFilter] = useState<string>('all')
  const [selectedLine, setSelectedLine] = useState<string>('')

  const activeLine = selectedLine || (lines[0]?.name ?? '')
  const { data: logs = [] } = useLogs(activeLine)
  const currentLine = lines.find(l => l.name === activeLine)

  const filteredLogs = useMemo(() => {
    if (logFilter === 'all') return logs
    return logs.filter(l => l.level === logFilter)
  }, [logs, logFilter])

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
      className="flex-1 flex min-h-0 overflow-hidden"
      style={{ padding: 'var(--sp-4)', gap: 'var(--sp-3)' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, ease }}
    >

      {/* ═══ LEFT: Fleet Status (swapped from right) ═══ */}
      <div
        className="flex flex-col min-h-0"
        style={{
          flex: 1,
          background: 'var(--color-d1)',
          borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
        }}
      >
        {/* Row 1: Header — matches toolbar pattern */}
        <div
          className="flex items-center justify-between flex-shrink-0 bg-d3 c-toolbar"
          style={{ borderBottom: 'var(--bw) solid var(--b1)', minHeight: 'var(--toolbar-h)' }}
        >
          <span className="c-heading">Fleet Status</span>
          {alerts.length > 0 ? (
            <span className="flex items-center font-mono text-s-crit" style={{ fontSize: 'var(--font-size-label)', gap: 'var(--sp-1)' }}>
              <AlertTriangle size={12} strokeWidth={1.75} />
              {alerts.length} alert{alerts.length !== 1 ? 's' : ''}
            </span>
          ) : (
            <span className="flex items-center font-mono text-s-ok" style={{ fontSize: 'var(--font-size-label)', gap: 'var(--sp-1)' }}>
              <CheckCircle2 size={12} strokeWidth={1.75} />
              all healthy
            </span>
          )}
        </div>

        {/* Row 2: Summary stats — matches column header row */}
        <div
          className="flex items-center justify-between flex-shrink-0 c-cell"
          style={{ borderBottom: 'var(--bw) solid var(--b2)' }}
        >
          <div className="flex items-center" style={{ gap: 'var(--sp-3)' }}>
            <span className="c-label">{lines.length} lines</span>
            <span className="c-label">{lines.filter(l => l.status === 'online').length} online</span>
            {alerts.length > 0 && (
              <span className="font-mono text-s-crit" style={{ fontSize: 'var(--font-size-label)' }}>
                {alerts.length} unhealthy
              </span>
            )}
          </div>
        </div>

        {/* Instance cards */}
        <div className="flex-1 overflow-auto scrollbar-hide" style={{ padding: 'var(--sp-3)' }}>
          <div className="flex flex-col" style={{ gap: 'var(--sp-2)' }}>
            {lines.map(line => (
              <div
                key={line.name}
                className={`c-hover cursor-pointer ${
                  line.name === activeLine ? 'ring-1 ring-m-cht/30' : ''
                }`}
                style={{
                  padding: 'var(--sp-3) var(--sp-4)',
                  borderRadius: 'var(--radius-md)',
                  background: line.status === 'unreachable'
                    ? 'var(--s-crit-wash)'
                    : line.status === 'degraded'
                    ? 'var(--s-warn-wash)'
                    : 'var(--color-d2)',
                  borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)',
                }}
                onClick={() => setSelectedLine(line.name)}
              >
                {/* Row 1: Name + mode + phone */}
                <div className="flex items-center justify-between" style={{ marginBottom: 'var(--sp-2)' }}>
                  <div className="flex items-center" style={{ gap: 'var(--sp-2)' }}>
                    <StatusDot status={line.status} size="sm" />
                    <span className="font-sans font-medium text-t1" style={{ fontSize: 'var(--font-size-body)' }}>
                      {displayInstanceName(line.name)}
                    </span>
                    <ModeBadge mode={line.mode} />
                  </div>
                  <span className="c-label">{line.phone}</span>
                </div>

                {/* Row 2: Heartbeat + runtime stats */}
                <div className="flex items-center justify-between">
                  <HeartbeatStrip beats={line.heartbeat} />
                  <div className="flex items-center font-mono text-t4" style={{ fontSize: 'var(--font-size-sm)', gap: 'var(--sp-3)' }}>
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
                  <div className="flex" style={{ gap: 'var(--sp-2)', marginTop: 'var(--sp-3)', paddingTop: 'var(--sp-3)', borderTop: 'var(--bw) solid var(--b1)' }}>
                    {line.linkedStatus === 'unlinked' ? (
                      <button
                        className="c-btn"
                        style={{ padding: 'var(--sp-1) var(--sp-3)', fontSize: 'var(--font-size-label)' }}
                        onClick={e => { e.stopPropagation(); setRelinkTarget(line.name) }}
                      >
                        <Link2 size={12} strokeWidth={1.75} /> Re-link
                      </button>
                    ) : (
                      <button
                        className="c-btn"
                        style={{ padding: 'var(--sp-1) var(--sp-3)', fontSize: 'var(--font-size-label)' }}
                        onClick={e => {
                          e.stopPropagation()
                          toast.info(`Restarting ${line.name}...`)
                          api.restart(line.name)
                            .then(() => toast.success(`${line.name} restart requested`))
                            .catch(err => toast.error(`Failed: ${err.message}`))
                        }}
                      >
                        <Power size={12} strokeWidth={1.75} /> Restart
                      </button>
                    )}
                    <button
                      className="c-btn"
                      style={{ padding: 'var(--sp-1) var(--sp-3)', fontSize: 'var(--font-size-label)', color: 'var(--color-s-crit)' }}
                      onClick={e => { e.stopPropagation(); setDeleteTarget(line.name) }}
                    >
                      <Trash2 size={12} strokeWidth={1.75} /> Delete
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ═══ RIGHT: Log stream (swapped from left) ═══ */}
      <div
        className="flex flex-col min-h-0"
        style={{
          flex: 1.6,
          borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
        }}
      >
        {/* Row 1: Line picker toolbar — matches c-toolbar */}
        <div
          className="flex items-center justify-between flex-shrink-0 bg-d3 c-toolbar"
          style={{ borderBottom: 'var(--bw) solid var(--b1)', minHeight: 'var(--toolbar-h)' }}
        >
          <div className="flex items-center" style={{ gap: 'var(--sp-3)' }}>
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

        {/* Row 2: Level filter pills — matches column header row */}
        <div
          className="flex items-center justify-between flex-shrink-0 c-cell"
          style={{ borderBottom: 'var(--bw) solid var(--b2)' }}
        >
          <div className="flex" style={{ gap: 'var(--sp-1)' }}>
            {['all', 'error', 'warn', 'info', 'debug'].map(l => (
              <FilterPill
                key={l}
                label={l}
                isActive={logFilter === l}
                activeColor={l === 'error' ? 'text-s-crit' : l === 'warn' ? 'text-s-warn' : 'text-t2'}
                activeBorder={logFilter === l ? 'var(--bw) solid var(--b3)' : undefined}
                onClick={() => setLogFilter(l)}
              />
            ))}
          </div>

          <span className="c-label">{filteredLogs.length} entries</span>
        </div>

        {/* Log stream */}
        <div className="flex-1 overflow-auto scrollbar-hide font-mono" style={{ background: 'var(--color-d0)', fontSize: 'var(--font-size-data)' }}>
          {filteredLogs.length > 0 ? (
            filteredLogs.map((log: LogEntry, i: number) => (
              <div
                key={`${log.timestamp}-${log.source}-${i}`}
                className="flex items-start c-row-hover"
                style={{ borderBottom: 'var(--bw) solid var(--b1)' }}
              >
                {/* Timestamp */}
                <div
                  className="flex-shrink-0 text-t5"
                  style={{ width: 'var(--log-col-time)', padding: 'var(--sp-2) var(--sp-3)', borderRight: 'var(--bw) solid var(--b1)' }}
                >
                  {formatTimeWithSeconds(log.timestamp)}
                </div>
                {/* Level badge */}
                <div
                  className="flex-shrink-0 text-center"
                  style={{ width: 'var(--log-col-level)', padding: 'var(--sp-2)', borderRight: 'var(--bw) solid var(--b1)' }}
                >
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded font-medium ${levelColor[log.level]}`}
                    style={{ fontSize: 'var(--font-size-xs)', background: levelBg[log.level] }}
                  >
                    {log.level}
                  </span>
                </div>
                {/* Source */}
                <div
                  className="flex-shrink-0 text-t5 truncate"
                  style={{ width: 'var(--log-col-source)', padding: 'var(--sp-2) var(--sp-2)', borderRight: 'var(--bw) solid var(--b1)' }}
                >
                  {log.source}
                </div>
                {/* Message */}
                <div className={`flex-1 ${levelColor[log.level]}`} style={{ padding: 'var(--sp-2) var(--sp-3)' }}>
                  {log.msg}
                </div>
              </div>
            ))
          ) : (
            <div className="flex items-center justify-center py-20 text-t5 font-mono" style={{ fontSize: 'var(--font-size-data)' }}>
              {activeLine
                ? `No ${logFilter === 'all' ? '' : logFilter + ' '}logs for ${activeLine}`
                : 'Select a line to view logs'}
            </div>
          )}
        </div>

        {/* Status bar */}
        <div
          className="flex items-center justify-between flex-shrink-0 font-mono text-t5"
          style={{ fontSize: 'var(--font-size-xs)', padding: 'var(--sp-1h) var(--sp-4)', borderTop: 'var(--bw) solid var(--b1)', background: 'var(--color-d1)' }}
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

      <RelinkModal
        lineName={relinkTarget ?? ''}
        open={!!relinkTarget}
        onClose={() => setRelinkTarget(null)}
        onLinked={() => { setRelinkTarget(null); queryClient.invalidateQueries({ queryKey: ['lines'] }); toast.success('Instance re-linked!'); }}
      />
    </motion.div>
  )
}
