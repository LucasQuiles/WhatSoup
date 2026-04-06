import { useState } from 'react'
import { UserCheck, Ban, User, Users, UserPlus, UserX } from 'lucide-react'
import { useToast } from '../../hooks/toast-context'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import ConfirmDialog from '../ConfirmDialog'
import type { AccessEntry } from './types'

interface PendingAction { subjectType: string; subjectId: string; subjectName: string; action: 'allow' | 'block' }

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
    if (status === 'blocked') return <UserX size={16} strokeWidth={1.75} className="text-s-crit" />
    if (status === 'pending' || status === 'seen') return <UserPlus size={16} strokeWidth={1.75} className="text-s-warn" />
    return type === 'group'
      ? <Users size={16} strokeWidth={1.75} className="text-t3" />
      : <User size={16} strokeWidth={1.75} className="text-t3" />
  }

  const statusBadge: Record<string, { bg: string; color: string; label: string }> = {
    allowed: { bg: 'var(--s-ok-wash)', color: 'var(--color-s-ok)', label: 'allowed' },
    blocked: { bg: 'var(--s-crit-wash)', color: 'var(--color-s-crit)', label: 'blocked' },
    pending: { bg: 'var(--s-warn-wash)', color: 'var(--color-s-warn)', label: 'pending' },
    seen:    { bg: 'var(--s-warn-wash)', color: 'var(--color-s-warn)', label: 'seen' },
  }

  const renderItem = (entry: AccessEntry, showActions: 'pending' | 'allowed' | 'blocked') => (
    <div
      key={entry.subjectId}
      className="flex items-center gap-3 hover:bg-d3 c-hover"
      style={{
        padding: 'var(--sp-2h) var(--sp-4)',
        borderBottom: 'var(--bw) solid var(--b1)',
        ...(showActions === 'pending' ? { background: 'var(--s-warn-wash)' } : {}),
        ...(showActions === 'blocked' ? { opacity: 0.6 } : {}),
      }}
    >
      {/* Avatar */}
      <div
        className="rounded-full flex items-center justify-center flex-shrink-0"
        style={{ width: 'var(--avatar-sm)', height: 'var(--avatar-sm)', background: 'var(--color-d5)' }}
      >
        {statusIcon(entry.status, entry.subjectType)}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="font-sans font-medium text-t2" style={{ fontSize: 'var(--font-size-body)' }}>
          {entry.subjectName}
        </div>
        <div className="font-mono text-t4" style={{ fontSize: 'var(--font-size-sm)' }}>
          {entry.subjectId}
        </div>
      </div>

      {/* Status badge */}
      <span
        className="font-mono font-medium flex-shrink-0"
        style={{
          fontSize: 'var(--font-size-sm)',
          padding: '2px var(--sp-2)',
          borderRadius: 'var(--radius-sm)',
          background: statusBadge[entry.status]?.bg,
          color: statusBadge[entry.status]?.color,
        }}
      >
        {statusBadge[entry.status]?.label ?? entry.status}
      </span>

      {/* Actions */}
      {showActions === 'pending' && (
        <div className="flex gap-1.5">
          <button
            onClick={() => confirmAccess(entry.subjectType, entry.subjectId, entry.subjectName, 'allow')}
            className="flex items-center gap-1 px-2.5 py-1 rounded font-mono text-s-ok hover:bg-d5 cursor-pointer c-hover"
            style={{ fontSize: 'var(--font-size-label)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b2)' }}
          >
            <UserCheck size={11} strokeWidth={1.75} /> Allow
          </button>
          <button
            onClick={() => confirmAccess(entry.subjectType, entry.subjectId, entry.subjectName, 'block')}
            className="flex items-center gap-1 px-2.5 py-1 rounded font-mono text-s-crit hover:bg-d5 cursor-pointer c-hover"
            style={{ fontSize: 'var(--font-size-label)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b2)' }}
          >
            <Ban size={11} strokeWidth={1.75} /> Block
          </button>
        </div>
      )}
      {showActions === 'allowed' && (
        <button
          onClick={() => confirmAccess(entry.subjectType, entry.subjectId, entry.subjectName, 'block')}
          className="flex items-center gap-1 px-2 py-0.5 rounded font-mono text-s-crit hover:bg-d5 cursor-pointer c-hover"
          style={{ fontSize: 'var(--font-size-label)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b2)' }}
        >
          <Ban size={11} strokeWidth={1.75} />
        </button>
      )}
      {showActions === 'blocked' && (
        <button
          onClick={() => confirmAccess(entry.subjectType, entry.subjectId, entry.subjectName, 'allow')}
          className="flex items-center gap-1 px-2 py-0.5 rounded font-mono text-s-ok hover:bg-d5 cursor-pointer c-hover"
          style={{ fontSize: 'var(--font-size-label)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b2)' }}
        >
          <UserCheck size={11} strokeWidth={1.75} />
        </button>
      )}
    </div>
  )

  return (
    <div className="space-y-4">
      {/* Pending queue */}
      {pending.length > 0 && (
        <div className="rounded-lg overflow-hidden" style={{ borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)' }}>
          <div
            className="c-col-header text-t4"
            style={{ padding: 'var(--sp-2) var(--msg-pad-h)', borderBottom: 'var(--bw) solid var(--b1)', background: 'var(--color-d3)' }}
          >
            Pending ({pending.length})
          </div>
          {pending.map(e => renderItem(e, 'pending'))}
        </div>
      )}

      {/* Allowed + Blocked in two columns */}
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        <div className="rounded-lg overflow-hidden" style={{ borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)' }}>
          <div
            className="c-col-header text-t4"
            style={{ padding: 'var(--sp-2) var(--msg-pad-h)', borderBottom: 'var(--bw) solid var(--b1)', background: 'var(--color-d3)' }}
          >
            Allowed ({allowed.length})
          </div>
          {allowed.map(e => renderItem(e, 'allowed'))}
        </div>
        <div className="rounded-lg overflow-hidden" style={{ borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)' }}>
          <div
            className="c-col-header text-t4"
            style={{ padding: 'var(--sp-2) var(--msg-pad-h)', borderBottom: 'var(--bw) solid var(--b1)', background: 'var(--color-d3)' }}
          >
            Blocked ({blocked.length})
          </div>
          {blocked.length === 0 ? (
            <div className="text-t5 text-center py-6 font-mono" style={{ fontSize: 'var(--font-size-data)' }}>
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
