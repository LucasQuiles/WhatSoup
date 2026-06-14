import { useState } from 'react'
import { UserCheck, Ban, User, Users, UserPlus, UserX } from 'lucide-react'
import { useToast } from '../../hooks/toast-context'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import {
  statusBadgeStyle,
  statusTextClassForSeverity,
  type StatusSeverity,
} from '../../lib/status-severity'
import ConfirmDialog from '../ConfirmDialog'
import { Button } from '../primitives/Button'
import type { AccessEntry } from './types'

interface PendingAction { subjectType: string; subjectId: string; subjectName: string; action: 'allow' | 'block' }

const ACCESS_STATUS_SEVERITY: Readonly<Record<AccessEntry['status'], StatusSeverity>> = {
  allowed: 'ok',
  blocked: 'crit',
  pending: 'warn',
  seen: 'warn',
} as const

function accessStatusSeverity(status: string): StatusSeverity | null {
  return status in ACCESS_STATUS_SEVERITY ? ACCESS_STATUS_SEVERITY[status as AccessEntry['status']] : null
}

function accessStatusBadge(status: string): { bg: string; color: string; label: string } | null {
  const severity = accessStatusSeverity(status)
  return severity ? { ...statusBadgeStyle(severity), label: status } : null
}

export function AccessTab({ access, lineName }: { access: AccessEntry[]; lineName: string }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)

  const confirmAccess = (subjectType: string, subjectId: string, subjectName: string, action: 'allow' | 'block') => {
    setPendingAction({ subjectType, subjectId, subjectName, action })
  }

  const executeAccess = async () => {
    if (!pendingAction) return
    const { subjectType, subjectId, subjectName, action } = pendingAction
    const label = action === 'allow' ? 'Allow' : 'Block'
    try {
      await api.accessDecision(lineName, subjectType, subjectId, action)
      toast.success(`${label}ed ${subjectName}`)
      queryClient.invalidateQueries({ queryKey: ['access', lineName] })
    } catch (e) {
      toast.error(`${label} failed: ${(e as Error).message}`)
    } finally {
      setPendingAction(null)
    }
  }
  const allowed = access.filter(e => e.status === 'allowed')
  const blocked = access.filter(e => e.status === 'blocked')
  const pending = access.filter(e => e.status === 'pending' || e.status === 'seen')

  const statusIcon = (status: string, type: string) => {
    const severity = accessStatusSeverity(status)
    if (severity === 'crit') return <UserX size={16} strokeWidth={1.75} className={statusTextClassForSeverity(severity)} />
    if (severity === 'warn') return <UserPlus size={16} strokeWidth={1.75} className={statusTextClassForSeverity(severity)} />
    return type === 'group'
      ? <Users size={16} strokeWidth={1.75} className="text-t3" />
      : <User size={16} strokeWidth={1.75} className="text-t3" />
  }

  const renderItem = (entry: AccessEntry, showActions: 'pending' | 'allowed' | 'blocked') => {
    const badge = accessStatusBadge(entry.status)
    return (
      <div
        key={entry.subjectId}
        className={`flex items-center gap-3 hover:bg-d3 c-hover py-[var(--sp-2h)] px-[var(--sp-4)] c-border-b${showActions === 'pending' ? ' bg-[var(--status-warn-wash)]' : ''}`}
        style={showActions === 'blocked' ? { opacity: 'var(--opacity-muted)' } : undefined}
      >
        {/* Avatar */}
        <div
          className="rounded-full flex items-center justify-center flex-shrink-0 w-[var(--avatar-sm)] h-[var(--avatar-sm)] bg-d5"
        >
          {statusIcon(entry.status, entry.subjectType)}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="font-sans font-medium text-t2 text-body">
            {entry.subjectName}
          </div>
          <div className="c-data text-t4">
            {entry.subjectId}
          </div>
        </div>

        {/* Status badge */}
        <span
          className="font-mono font-medium flex-shrink-0 rounded-sm py-[var(--sp-0h)] px-[var(--sp-2)] text-sm"
          style={{
            background: badge?.bg,
            color: badge?.color,
          }}
        >
          {badge?.label ?? entry.status}
        </span>

        {/* Actions */}
        {showActions === 'pending' && (
          <div className="flex gap-1.5">
            <Button
              variant="success"
              size="sm"
              onClick={() => confirmAccess(entry.subjectType, entry.subjectId, entry.subjectName, 'allow')}
              className="font-mono"
              icon={<UserCheck size={15} strokeWidth={1.75} />}
            >
              Allow
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => confirmAccess(entry.subjectType, entry.subjectId, entry.subjectName, 'block')}
              className="font-mono"
              icon={<Ban size={15} strokeWidth={1.75} />}
            >
              Block
            </Button>
          </div>
        )}
        {showActions === 'allowed' && (
          <Button
            variant="danger"
            size="sm"
            onClick={() => confirmAccess(entry.subjectType, entry.subjectId, entry.subjectName, 'block')}
            className="font-mono"
            aria-label="Block contact"
            icon={<Ban size={15} strokeWidth={1.75} />}
          />
        )}
        {showActions === 'blocked' && (
          <Button
            variant="success"
            size="sm"
            onClick={() => confirmAccess(entry.subjectType, entry.subjectId, entry.subjectName, 'allow')}
            className="font-mono"
            aria-label="Allow contact"
            icon={<UserCheck size={15} strokeWidth={1.75} />}
          />
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Pending queue */}
      {pending.length > 0 && (
        <div className="c-card overflow-hidden">
          <div
            className="c-toolbar c-border-b c-col-header text-t4"
          >
            Pending ({pending.length})
          </div>
          {pending.map(e => renderItem(e, 'pending'))}
        </div>
      )}

      {/* Allowed + Blocked in two columns */}
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(var(--panel-access-col), 1fr))' }}>
        <div className="c-card overflow-hidden">
          <div
            className="c-toolbar c-border-b c-col-header text-t4"
          >
            Allowed ({allowed.length})
          </div>
          {allowed.map(e => renderItem(e, 'allowed'))}
        </div>
        <div className="c-card overflow-hidden">
          <div
            className="c-toolbar c-border-b c-col-header text-t4"
          >
            Blocked ({blocked.length})
          </div>
          {blocked.length === 0 ? (
            <div className="text-t5 text-center py-6 font-mono text-data">
              No blocked contacts
            </div>
          ) : (
            blocked.map(e => renderItem(e, 'blocked'))
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!pendingAction}
        title={`${pendingAction?.action === 'allow' ? 'Allow' : 'Block'} ${pendingAction?.subjectName ?? ''}?`}
        confirmLabel={pendingAction?.action === 'allow' ? 'Allow' : 'Block'}
        confirmVariant={pendingAction?.action === 'allow' ? 'primary' : 'danger'}
        confirmIcon={pendingAction?.action === 'allow' ? <UserCheck size={14} /> : <Ban size={14} />}
        onConfirm={executeAccess}
        onCancel={() => setPendingAction(null)}
      >
        {pendingAction?.action === 'allow'
          ? <>This will grant <strong>{pendingAction.subjectName}</strong> access to this instance.</>
          : <>This will block <strong>{pendingAction?.subjectName}</strong> from contacting this instance.</>
        }
      </ConfirmDialog>
    </div>
  )
}
