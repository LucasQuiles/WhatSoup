import {
  Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
  TableEmpty, TableError, TableLoading,
} from '../primitives/Table'
import { statusBadgeStyle, type StatusSeverity } from '../../lib/status-severity'
import { formatRelative } from '../../lib/format-time'
import type { Freshness } from '../../lib/freshness'
import type { CheckpointRow, CheckpointsPayload } from '../../types'

/**
 * CheckpointsTab — read-only browser for a line's session_checkpoints
 * (spec: oc-re/specs/2026-07-19-checkpoint-browser-ui-spec.md).
 *
 * Shows which sessions would resume on restart (`resumable` is computed
 * server-side with the durability engine's exact filter), the lifecycle
 * status of every checkpoint, and the completed-delivery identity bundle.
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

export function CheckpointsTab({ payload, isLoading, freshness }: {
  payload: CheckpointsPayload | undefined;
  isLoading: boolean;
  freshness: Freshness;
}) {
  const rows = payload?.checkpoints ?? []
  const resumableCount = rows.filter((r) => r.resumable).length

  return (
    <div>
      {/* Header: count summary + freshness marker (GUI-5 idiom: c-label + text-s-warn) */}
      <div className="flex items-baseline gap-[var(--sp-3)] mb-[var(--sp-2)]">
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
            <TableHeaderCell>Conversation</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableHeaderCell>Resumable</TableHeaderCell>
            <TableHeaderCell>Version</TableHeaderCell>
            <TableHeaderCell>PID</TableHeaderCell>
            <TableHeaderCell>Scope</TableHeaderCell>
            <TableHeaderCell>Updated</TableHeaderCell>
            <TableHeaderCell>Workspace</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && <TableLoading colSpan={8} />}
          {!isLoading && payload?.readError && (
            <TableError
              colSpan={8}
              message="Checkpoint data unavailable — the fleet could not read this instance's database. This is a read failure, not an empty instance."
            />
          )}
          {!isLoading && !payload?.readError && rows.length === 0 && (
            <TableEmpty colSpan={8} message="No session checkpoints recorded for this line yet." />
          )}
          {!isLoading && !payload?.readError && rows.map((row) => (
            <CheckpointTableRow key={row.conversationKey} row={row} />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function CheckpointTableRow({ row }: { row: CheckpointRow }) {
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
        <span title={row.updatedAt}>{formatRelative(row.updatedAt)}</span>
      </TableCell>
      <TableCell>
        <span title={row.workspacePath ?? undefined}>{workspaceTail(row.workspacePath)}</span>
      </TableCell>
    </TableRow>
  )
}
