import { useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
  TableEmpty, TableError, TableLoading,
  type SortState,
} from '../primitives/Table'
import { Button } from '../primitives/Button'
import ConfirmDialog from '../ConfirmDialog'
import { api } from '../../lib/api'
import { useToast } from '../../hooks/toast-context'
import { statusBadgeStyle, type StatusSeverity } from '../../lib/status-severity'
import { formatRelative } from '../../lib/format-time'
import type { Freshness } from '../../lib/freshness'
import type { CheckpointRow, CheckpointsPayload } from '../../types'

/**
 * CheckpointsTab — browser + restart-mediated restore for a line's
 * session_checkpoints (spec: oc-re/specs/2026-07-19-checkpoint-browser-ui-spec.md;
 * sort + Delivery column: oc-re/specs/2026-07-19-checkpoints-tab-followups-spec.md;
 * Restore action: oc-re/specs/2026-07-19-checkpoint-restore-spec.md).
 *
 * Shows which sessions would resume on restart (`resumable` is computed
 * server-side with the durability engine's exact filter), the lifecycle
 * status of every checkpoint, and the completed-delivery identity bundle
 * (Delivery column: truncated JID, full JID + turn id on the title — the
 * aliasing-safe answer to "WHICH chat did this turn deliver to").
 * Conversation and Updated are sortable (client-side, tri-state); the
 * default view preserves the server's updated_at DESC order.
 * The Restore action marks a non-resumable checkpoint resumable and
 * restarts the instance so the LIVE runtime resumes it through its own
 * resume gate — the console never resumes a session itself.
 * Fail-closed: a fleet read error renders TableError — never a fake empty
 * state (PDR-3 invariant).
 */

const STATUS_SEVERITY: Readonly<Record<string, StatusSeverity>> = {
  active: 'ok',
  suspended: 'ok',
  ended: 'ok',
  orphaned: 'warn',
} as const

function statusSeverity(status: string): StatusSeverity {
  return STATUS_SEVERITY[status] ?? 'warn'
}

function truncateMiddle(value: string, head = 14, tail = 10): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`
}

function workspaceTail(path: string | null): string {
  if (!path) return '—'
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function deliveryTitle(row: CheckpointRow): string | undefined {
  if (!row.completedDeliveryJid) return undefined
  return row.completedLogicalTurnId
    ? `${row.completedDeliveryJid} · turn ${row.completedLogicalTurnId}`
    : row.completedDeliveryJid
}

type SortKey = 'conversation' | 'updated' | null

export function CheckpointsTab({ payload, isLoading, freshness, lineName }: {
  payload: CheckpointsPayload | undefined;
  isLoading: boolean;
  freshness: Freshness;
  /** Owning line — the restore action's api target + invalidate key. */
  lineName: string;
}) {
  // Wrapped in useMemo per exhaustive-deps: the `?? []` fallback would
  // otherwise give sortedRows' useMemo a new dep identity every render.
  const rows = useMemo(() => payload?.checkpoints ?? [], [payload])
  const resumableCount = rows.filter((r) => r.resumable).length

  // Restore flow — AccessTab idiom: pending row → ConfirmDialog → api →
  // toast + invalidate; ref-guard against double-submit while in flight.
  const toast = useToast()
  const queryClient = useQueryClient()
  const [pendingRestore, setPendingRestore] = useState<CheckpointRow | null>(null)
  const [executingRestore, setExecutingRestore] = useState(false)
  const executingRestoreRef = useRef(false)

  const executeRestore = async () => {
    if (!pendingRestore) return
    if (executingRestoreRef.current) return
    executingRestoreRef.current = true
    setExecutingRestore(true)
    const key = pendingRestore.conversationKey
    try {
      await api.restoreCheckpoint(lineName, key)
      toast.success(`Restore requested for ${truncateMiddle(key)} — ${lineName} is restarting`)
      queryClient.invalidateQueries({ queryKey: ['checkpoints', lineName] })
    } catch (e) {
      toast.error(`Restore failed: ${(e as Error).message}`)
    } finally {
      executingRestoreRef.current = false
      setExecutingRestore(false)
      setPendingRestore(null)
    }
  }

  // SoupKitchen sort idiom: the primitive's tri-state cycle (none/asc/desc)
  // adapted onto two-way sortDir; 'none' clears back to the server default
  // (updated_at DESC). Client-side over at most 500 rows.
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const handleSort = (next: SortState) => {
    if (next.dir === 'none') {
      setSortKey(null)
      setSortDir('desc')
    } else {
      setSortKey(next.key as SortKey)
      setSortDir(next.dir === 'asc' ? 'asc' : 'desc')
    }
  }
  const sortState: SortState = useMemo(
    () => ({ key: sortKey ?? '', dir: sortKey ? sortDir : 'none' }),
    [sortKey, sortDir],
  )
  const sortedRows = useMemo(() => {
    if (!sortKey) return rows
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      switch (sortKey) {
        case 'conversation':
          return dir * a.conversationKey.localeCompare(b.conversationKey)
        case 'updated':
          // updatedAt is ISO-8601 (sqliteUtcToIso) — lexicographic = chronological
          return dir * (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0)
      }
    })
  }, [rows, sortKey, sortDir])

  return (
    <div>
      {/* Header: count summary + freshness marker (GUI-5 idiom: c-label + text-s-warn) */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
        <span className="c-label">
          {rows.length} checkpoint{rows.length === 1 ? '' : 's'} · {resumableCount} resumable on restart
        </span>
        <span
          className={`c-label${freshness.stale || payload?.readError ? ' text-s-warn' : ''}`}
          title={payload ? `observed ${payload.observedAt}` : undefined}
        >
          {payload?.readError
            ? 'read unavailable'
            : payload
              ? `observed ${formatRelative(payload.observedAt)}${freshness.stale ? ' (stale)' : ''}`
              : 'not observed'}
        </span>
      </div>

      <Table density="compressed">
        <TableHeader>
          <TableRow>
            <TableHeaderCell sortKey="conversation" sort={sortState} onSort={handleSort}>Conversation</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableHeaderCell>Resumable</TableHeaderCell>
            <TableHeaderCell>Version</TableHeaderCell>
            <TableHeaderCell>PID</TableHeaderCell>
            <TableHeaderCell>Scope</TableHeaderCell>
            <TableHeaderCell>Delivery</TableHeaderCell>
            <TableHeaderCell sortKey="updated" sort={sortState} onSort={handleSort}>Updated</TableHeaderCell>
            <TableHeaderCell>Workspace</TableHeaderCell>
            <TableHeaderCell>Action</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && <TableLoading colSpan={10} />}
          {!isLoading && payload?.readError && (
            <TableError
              colSpan={10}
              message="Checkpoint data unavailable — the fleet could not read this instance's database. This is a read failure, not an empty instance."
            />
          )}
          {!isLoading && !payload?.readError && sortedRows.length === 0 && (
            <TableEmpty colSpan={10} message="No session checkpoints recorded for this line yet." />
          )}
          {!isLoading && !payload?.readError && sortedRows.map((row) => (
            <CheckpointTableRow key={row.conversationKey} row={row} onRestore={() => setPendingRestore(row)} />
          ))}
        </TableBody>
      </Table>

      <ConfirmDialog
        open={!!pendingRestore}
        title="Restore checkpoint?"
        confirmLabel="Restore & Restart"
        confirmVariant="primary"
        confirmDisabled={executingRestore}
        confirmLoading={executingRestore}
        onConfirm={executeRestore}
        onCancel={() => setPendingRestore(null)}
      >
        {pendingRestore && (
          <>
            This marks the checkpoint for <strong>{truncateMiddle(pendingRestore.conversationKey)}</strong> resumable
            and restarts instance <strong>{lineName}</strong> so the runtime resumes it through its own resume
            gate. The instance is briefly unavailable.
          </>
        )}
      </ConfirmDialog>
    </div>
  )
}

function CheckpointTableRow({ row, onRestore }: { row: CheckpointRow; onRestore: () => void }) {
  const severity = statusSeverity(row.sessionStatus)
  const badge = statusBadgeStyle(severity)
  return (
    <TableRow severity={severity === 'warn' ? 'warn' : undefined}>
      <TableCell>
        <span title={row.conversationKey}>{truncateMiddle(row.conversationKey)}</span>
      </TableCell>
      <TableCell>
        <span
          className="font-mono font-medium flex-shrink-0 rounded-sm py-[var(--sp-0h)] px-[var(--sp-2)] text-sm"
          style={{ background: badge.bg, color: badge.color }}
        >
          {row.sessionStatus}
        </span>
      </TableCell>
      <TableCell>
        {row.resumable
          ? <span className="c-label" title="Would resume on restart (engine filter: active/suspended + session id)">resumable</span>
          : <span className="c-label">—</span>}
      </TableCell>
      <TableCell>v{row.checkpointVersion}</TableCell>
      <TableCell>{row.claudePid ?? '—'}</TableCell>
      <TableCell>{row.completedScope ?? '—'}</TableCell>
      <TableCell>
        {row.completedDeliveryJid
          ? <span title={deliveryTitle(row)}>{truncateMiddle(row.completedDeliveryJid)}</span>
          : '—'}
      </TableCell>
      <TableCell>
        <span title={row.updatedAt}>{formatRelative(row.updatedAt)}</span>
      </TableCell>
      <TableCell>
        <span title={row.workspacePath ?? undefined}>{workspaceTail(row.workspacePath)}</span>
      </TableCell>
      <TableCell>
        {/* Restore is offered only where the resume gate CAN admit the row
            (not already resumable + session id present). A null session id
            can never be invented — the dash says why (fail-visible). */}
        {!row.resumable && row.sessionId
          ? <Button size="xs" variant="ghost" onClick={onRestore}>Restore</Button>
          : !row.sessionId
            ? <span title="No session id — cannot be made resumable">—</span>
            : '—'}
      </TableCell>
    </TableRow>
  )
}
